import type { Request, Response } from "express";

import { checkHealth } from "./health.service.js";

export async function getHealth(
  req: Request,
  res: Response,
): Promise<void> {
    const health = await checkHealth();

    if (!health.ready) {
        res.status(503).json({status: "not_ready"});
    }
    else{
        res.status(200).json({status: "ok"});
    }   

}