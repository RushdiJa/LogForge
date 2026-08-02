import { Router } from "express";
import { getHealth } from "./health.controller.js";

export const healthRouter : Router = Router();
healthRouter.get("/", getHealth);