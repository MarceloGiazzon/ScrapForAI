param(
    [Parameter(Mandatory = $true)]
    [string]$Url,

    [Parameter(Mandatory = $true)]
    [string]$KeyPath,

    [Parameter(Mandatory = $true)]
    [string]$JsonPath,

    [string]$OutputPath,

    [int]$TimeoutSec = 180,

    [switch]$Raw
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Resolve-ExistingFile {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Path,

        [Parameter(Mandatory = $true)]
        [string]$Name
    )

    $resolved = Resolve-Path -LiteralPath $Path -ErrorAction Stop
    $item = Get-Item -LiteralPath $resolved.Path -ErrorAction Stop

    if (-not $item.PSIsContainer) {
        return $item.FullName
    }

    throw "$Name must be a file: $Path"
}

function Get-RunUrl {
    param(
        [Parameter(Mandatory = $true)]
        [string]$InputUrl
    )

    $trimmed = $InputUrl.Trim()

    if ($trimmed -match "/v1/explorations/run/?$") {
        return $trimmed.TrimEnd("/")
    }

    return "$($trimmed.TrimEnd("/"))/v1/explorations/run"
}

function Get-ExceptionResponse {
    param(
        [object]$Exception
    )

    if ($null -eq $Exception) {
        return $null
    }

    $responseProperty = $Exception.PSObject.Properties["Response"]
    if ($null -eq $responseProperty) {
        return $null
    }

    return $responseProperty.Value
}

function Get-ConnectionErrorHint {
    param(
        [Parameter(Mandatory = $true)]
        [string]$RunUrl
    )

    $projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
    return @(
        "Cannot connect to $RunUrl."
        "Is the ScrapForAI API running?"
        "Start it in another terminal:"
        "  cd $projectRoot"
        "  npm run dev"
    ) -join "`n"
}

function Test-ConnectionErrorMessage {
    param(
        [string]$Message
    )

    if ([string]::IsNullOrWhiteSpace($Message)) {
        return $false
    }

    return $Message -match '(?i)(actively refused|No connection could be made|connection attempt failed|Unable to connect|Name or service not known|nodename nor servname provided)'
}

function Read-WebExceptionBody {
    param(
        [Parameter(Mandatory = $true)]
        [object]$Exception
    )

    $response = Get-ExceptionResponse -Exception $Exception
    if ($null -eq $response) {
        return $null
    }

    if ($response.PSObject.Properties["Content"] -and $response.Content -and $response.Content.PSObject.Methods["ReadAsStringAsync"]) {
        return $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
    }

    $stream = if ($response.PSObject.Methods["GetResponseStream"]) { $response.GetResponseStream() } else { $null }
    if ($null -eq $stream) {
        return $null
    }

    $reader = [System.IO.StreamReader]::new($stream)
    try {
        return $reader.ReadToEnd()
    }
    finally {
        $reader.Dispose()
    }
}

function Get-JsonProperty {
    param(
        [Parameter(Mandatory = $true)]
        [object]$Object,

        [Parameter(Mandatory = $true)]
        [string]$Name
    )

    $property = $Object.PSObject.Properties[$Name]
    if ($null -eq $property) {
        return $null
    }

    return $property.Value
}

function ConvertTo-Array {
    param(
        [object]$Value
    )

    if ($null -eq $Value) {
        return @()
    }

    if ($Value -is [System.Array]) {
        return $Value
    }

    return @($Value)
}

function ConvertTo-PrettyJson {
    param(
        [Parameter(Mandatory = $true)]
        [object]$Value
    )

    return $Value | ConvertTo-Json -Depth 100
}

$keyFile = Resolve-ExistingFile -Path $KeyPath -Name "KeyPath"
$jsonFile = Resolve-ExistingFile -Path $JsonPath -Name "JsonPath"
$runUrl = Get-RunUrl -InputUrl $Url

$apiKey = (Get-Content -Raw -LiteralPath $keyFile).Trim()
if ([string]::IsNullOrWhiteSpace($apiKey)) {
    throw "API key file is empty: $keyFile"
}

$body = Get-Content -Raw -LiteralPath $jsonFile
try {
    $null = $body | ConvertFrom-Json -ErrorAction Stop
}
catch {
    throw "JsonPath is not valid JSON: $jsonFile. $($_.Exception.Message)"
}

$headers = @{
    Authorization = "Bearer $apiKey"
}

$content = $null
$statusCode = $null

try {
    $response = Invoke-WebRequest `
        -Method Post `
        -Uri $runUrl `
        -Headers $headers `
        -ContentType "application/json" `
        -Body $body `
        -TimeoutSec $TimeoutSec `
        -UseBasicParsing

    $statusCode = [int]$response.StatusCode
    $content = $response.Content
}
catch {
    $response = Get-ExceptionResponse -Exception $_.Exception
    $statusCode = if ($null -ne $response -and $response.PSObject.Properties["StatusCode"]) {
        [int]$response.StatusCode
    }
    else {
        $null
    }

    $content = if ($_.ErrorDetails -and $_.ErrorDetails.Message) {
        $_.ErrorDetails.Message
    }
    else {
        Read-WebExceptionBody -Exception $_.Exception
    }

    if ([string]::IsNullOrWhiteSpace($content)) {
        if (Test-ConnectionErrorMessage -Message $_.Exception.Message) {
            throw (Get-ConnectionErrorHint -RunUrl $runUrl)
        }

        throw
    }
}

try {
    $result = $content | ConvertFrom-Json -ErrorAction Stop
}
catch {
    Write-Host "HTTP status: $statusCode"
    Write-Host $content
    exit 1
}

if ($OutputPath) {
    $outputFullPath = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath($OutputPath)
    $outputDir = Split-Path -Parent $outputFullPath
    if ($outputDir) {
        New-Item -ItemType Directory -Force -Path $outputDir | Out-Null
    }
    ConvertTo-PrettyJson -Value $result | Set-Content -LiteralPath $outputFullPath -Encoding UTF8
}

if ($Raw) {
    ConvertTo-PrettyJson -Value $result
}
else {
    $jobId = Get-JsonProperty -Object $result -Name "jobId"
    $routineStatus = Get-JsonProperty -Object $result -Name "status"
    $failedStepIndex = Get-JsonProperty -Object $result -Name "failedStepIndex"
    $finalUrl = Get-JsonProperty -Object $result -Name "finalUrl"
    $errorObject = Get-JsonProperty -Object $result -Name "error"
    $evidence = Get-JsonProperty -Object $result -Name "evidence"

    Write-Host "ScrapForAI routine execution"
    Write-Host "URL: $runUrl"
    Write-Host "HTTP status: $statusCode"

    if ($jobId) {
        Write-Host "Job ID: $jobId"
    }

    if ($routineStatus) {
        Write-Host "Routine status: $routineStatus"
    }

    if ($null -ne $failedStepIndex) {
        Write-Host "Failed step index: $failedStepIndex"
    }

    if ($finalUrl) {
        Write-Host "Final URL: $finalUrl"
    }

    if ($errorObject) {
        $errorType = Get-JsonProperty -Object $errorObject -Name "type"
        $errorMessage = Get-JsonProperty -Object $errorObject -Name "message"
        $errorDetails = Get-JsonProperty -Object $errorObject -Name "details"
        Write-Host "Error type: $errorType"
        Write-Host "Error message: $errorMessage"

        $errorDetailItems = ConvertTo-Array -Value $errorDetails
        if (@($errorDetailItems).Count -gt 0) {
            Write-Host "Validation details:"
            foreach ($detail in $errorDetailItems) {
                $detailPath = Get-JsonProperty -Object $detail -Name "path"
                $detailMessage = Get-JsonProperty -Object $detail -Name "message"
                if ([string]::IsNullOrWhiteSpace($detailPath)) {
                    $detailPath = "<root>"
                }
                Write-Host "  - ${detailPath}: $detailMessage"
            }
        }
    }

    if ($evidence) {
        $tracePath = Get-JsonProperty -Object $evidence -Name "tracePath"
        $screenshots = Get-JsonProperty -Object $evidence -Name "screenshots"

        if ($tracePath) {
            Write-Host "Trace: $tracePath"
        }

        $screenshotItems = ConvertTo-Array -Value $screenshots
        if (@($screenshotItems).Count -gt 0) {
            Write-Host "Screenshots:"
            foreach ($screenshot in $screenshotItems) {
                $screenshotName = Get-JsonProperty -Object $screenshot -Name "name"
                $screenshotPath = Get-JsonProperty -Object $screenshot -Name "path"
                Write-Host "  - ${screenshotName}: $screenshotPath"
            }
        }
    }

    if ($OutputPath) {
        Write-Host "Saved response: $outputFullPath"
    }
}

if ($statusCode -ge 400) {
    exit 1
}

$finalStatus = Get-JsonProperty -Object $result -Name "status"
if ($finalStatus -and $finalStatus -ne "passed") {
    exit 1
}
