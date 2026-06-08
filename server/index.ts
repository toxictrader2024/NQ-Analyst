import "dotenv/config";
import express, { Response, NextFunction } from 'express';
import type { Request } from 'express';
import { registerRoutes } from "./routes";
import { startPulse } from "./commentaryEngine";
import { serveStatic } from "./static";
import { clearExpiredSignals } from "./signalEngine";
import { createServer } from "node:http";

const app = express();
const httpServer = createServer(app);

declare module "http" {
  interface IncomingMessage {
    rawBody: unknown;
  }
}

app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  }),
);

app.use(express.urlencoded({ extended: false }));

export function log(message: string, source = "express") {
  const formattedTime = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });

  console.log(`${formattedTime} [${source}] ${message}`);
}

app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;
  let capturedJsonResponse: Record<string, any> | undefined = undefined;

  const originalResJson = res.json;
  res.json = function (bodyJson, ...args) {
    capturedJsonResponse = bodyJson;
    return originalResJson.apply(res, [bodyJson, ...args]);
  };

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path.startsWith("/api")) {
      let logLine = `${req.method} ${path} ${res.statusCode} in ${duration}ms`;
      if (capturedJsonResponse) {
        logLine += ` :: ${JSON.stringify(capturedJsonResponse)}`;
      }

      log(logLine);
    }
  });

  next();
});

(async () => {
  await registerRoutes(httpServer, app);

  app.use((err: any, _req: Request, res: Response, next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";

    console.error("Internal Server Error:", err);

    if (res.headersSent) {
      return next(err);
    }

    return res.status(status).json({ message });
  });

  // importantly only setup vite in development and after
  // setting up all the other routes so the catch-all route
  // doesn't interfere with the other routes
  if (process.env.NODE_ENV === "production") {
    serveStatic(app);
  } else {
    const { setupVite } = await import("./vite");
    await setupVite(httpServer, app);
  }

  // ALWAYS serve the app on the port specified in the environment variable PORT
  // Other ports are firewalled. Default to 5000 if not specified.
  // this serves both the API and the client.
  // It is the only port that is not firewalled.
  const port = parseInt(process.env.PORT || "5000", 10);
  httpServer.listen(
    {
      port,
      host: "0.0.0.0",
      reusePort: true,
    },
    () => {
      log(`serving on port ${port}`);
      startPulse(); // start 5-minute AI market pulse

      // Sweep expired pending signals every 30 seconds
      // Without this, clearExpiredSignals only runs on webhook receipt
      // If NT8 goes quiet, stale signals block new ones indefinitely
      setInterval(() => clearExpiredSignals(), 30 * 1000);
    },
  );

  // ── Keep-alive ping during market hours (6am–5pm CT = 11am–10pm UTC weekdays)
  // Prevents Render free tier from sleeping mid-session
  if (process.env.RENDER_EXTERNAL_URL) {
    setInterval(() => {
      const now = new Date();
      const utcHour = now.getUTCHours();
      const utcDay  = now.getUTCDay(); // 0=Sun, 6=Sat
      const isWeekday = utcDay >= 1 && utcDay <= 5;
      const isMarketHours = utcHour >= 11 && utcHour < 22; // 6am–5pm CT
      if (isWeekday && isMarketHours) {
        fetch(`${process.env.RENDER_EXTERNAL_URL}/api/dashboard`)
          .catch(() => {}); // silent — just keeping the dyno warm
      }
    }, 10 * 60 * 1000); // every 10 minutes
  }
})();
