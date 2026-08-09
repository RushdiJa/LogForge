import express, { type Express, type Request, type Response } from 'express';
import {healthRouter} from "./modules/health/health.routes.js";
import { logsRouter } from './modules/logs/logs.routes.ts';

export function test() {
    // npm run test
}
export function createApp() : Express {
    const app: Express = express();

    app.use(express.json({limit: "1mb"}));
    app.use('/health', healthRouter);
    app.use('/logs', logsRouter);
    
    return app;
}