import { Request, Response, NextFunction } from "express";
import { generateRequestId, structuredLog } from "../shared/utils/errors";

export function requestIdMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  (req as any).id = generateRequestId();
  res.setHeader("X-Request-Id", (req as any).id);
  next();
}

export function loggerMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const start = Date.now();
  res.on("finish", () => {
    const duration = Date.now() - start;
    structuredLog({
      level: res.statusCode >= 400 ? "warn" : "info",
      requestId: (req as any).id,
      message: `${req.method} ${req.originalUrl} ${res.statusCode} ${duration}ms`,
      context: {
        method: req.method,
        path: req.originalUrl,
        statusCode: res.statusCode,
        durationMs: duration,
        ip: req.ip,
      },
    });
  });
  next();
}
