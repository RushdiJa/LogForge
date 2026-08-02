import express, { type Express, type Request, type Response } from 'express';


export function createApp() : Express {
    const app: Express = express();

    app.use(express.json());
    app.get('/health', (req: Request, res: Response) => {
        res.status(200).json({ status: 'OK' });
    });

    return app;
}