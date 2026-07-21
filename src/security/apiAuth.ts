import crypto from 'node:crypto';

import type { NextFunction, Request, Response } from 'express';

import { env } from '../config/env.js';

function timingSafeEqualText(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);

  if (leftBuffer.length !== rightBuffer.length) {
    crypto.timingSafeEqual(leftBuffer, leftBuffer);
    return false;
  }

  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

export function apiAuth(req: Request, res: Response, next: NextFunction): void {
  if (req.method === 'GET' && (req.path === '/health' || req.path === '/v1/schema' || req.path.startsWith('/v1/schema/'))) {
    next();
    return;
  }

  const header = req.get('authorization') ?? '';
  const match = header.match(/^Bearer\s+(.+)$/i);

  if (!match || !timingSafeEqualText(match[1] ?? '', env.SCRAPFORAI_API_KEY)) {
    res.status(401).json({
      error: {
        type: 'Unauthorized',
        message: 'Missing or invalid API token',
      },
    });
    return;
  }

  next();
}
