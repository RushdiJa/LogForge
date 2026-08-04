import { Router } from "express";
import {createLogs} from "./logs.controller.ts"
export const logsRouter : Router = Router();
logsRouter.post("/", createLogs);
// later we should make error handler middleware for errors and http response