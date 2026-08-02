import express, { type Express, type Request, type Response } from 'express';
import {healthRouter} from "./modules/health/health.routes.js";

export function createApp() : Express {
    const app: Express = express();

    app.use(express.json());
    app.use('/health', healthRouter);
    
    return app;
}