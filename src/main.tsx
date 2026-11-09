import express from "express";
import cookieParser from "cookie-parser";
import cors from "cors";
import helmet from "helmet";
import { requestIdMiddleware } from "./middleware/request";
import { loggerMiddleware } from "./middleware/request";
import { errorHandler } from "./middleware/auth";
import { generalRateLimiter } from "./middleware/rate-limit";
import authRoutes from "./modules/auth/routes";
import sellerRoutes from "./modules/sellers/routes";
import storeRoutes from "./modules/stores/routes";
import catalogRoutes from "./modules/catalog/routes";
import orderRoutes from "./modules/orders/routes";
import customerRoutes from "./modules/customers/routes";
import reviewRoutes from "./modules/reviews/routes";
import financeRoutes from "./modules/finance/routes";
import notificationRoutes from "./modules/notifications/routes";
import analyticsRoutes from "./modules/analytics/routes";

const app = express();
const PORT = Number(process.env.PORT) || 4000;

const corsOrigin =
  process.env.CORS_ORIGIN || "http://localhost:3000,http://localhost:3001";
const allowedOrigins = corsOrigin.split(",").map((o) => o.trim());

app.use(helmet());
app.use(
  cors({
    origin: function (origin, callback) {
      // Sem Origin (curl, same-origin, apps móveis): segue sem CORS.
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes(origin)) {
        return callback(null, origin);
      }
      // Origem não listada: nega o pré-voo (não espelha origem não autorizada).
      return callback(null, false);
    },
    credentials: true,
    methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "Cookie",
      "Idempotency-Key",
    ],
    exposedHeaders: ["X-Request-Id"],
  }),
);
app.use(cookieParser());
app.use(express.json({ limit: "2mb" }));

app.use(requestIdMiddleware);
app.use(loggerMiddleware);
app.use(generalRateLimiter);

// Health check
app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    service: "integration-api",
    time: new Date().toISOString(),
  });
});

// API routes under /api/v1
const apiPrefix = "/api/v1";

app.get(apiPrefix, (_req, res) => {
  res.json({
    status: "ok",
    service: "seller-integration-api",
    message: "API online. Use /auth/login or /seller/...",
    time: new Date().toISOString(),
  });
});

app.use(`${apiPrefix}/auth`, authRoutes);
app.use(`${apiPrefix}`, sellerRoutes);
app.use(`${apiPrefix}/seller`, storeRoutes);
app.use(`${apiPrefix}/seller`, catalogRoutes);
app.use(`${apiPrefix}/seller`, orderRoutes);
app.use(`${apiPrefix}/seller`, customerRoutes);
app.use(`${apiPrefix}/seller`, reviewRoutes);
app.use(`${apiPrefix}/seller`, financeRoutes);
app.use(`${apiPrefix}/seller`, notificationRoutes);
app.use(`${apiPrefix}/seller`, analyticsRoutes);
// Public catalog categories endpoint (not under /seller per spec)
app.use(`${apiPrefix}/catalog`, catalogRoutes);

// 404
app.use((_req, res) => {
  res.status(404).json({
    error: {
      code: "ROUTE_NOT_FOUND",
      message: "Endpoint não encontrado.",
      requestId: (_req as any).id,
    },
  });
});

// Error handler (must be last)
app.use(errorHandler);

const isTestRun =
  process.env.NODE_ENV === "test" ||
  process.env.NODE_TEST_CONTEXT !== undefined ||
  process.argv.includes("--test");

if (!isTestRun) {
  app.listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`Integration API listening on http://localhost:${PORT}`);
  });
}

export default app;
