import { healthPg } from "../../db/index.js";

export async function checkDataBase(): 
Promise<boolean> {
    try{
        await healthPg`SELECT 1`;
        return true;
    }
    catch{
        return false;
    }
}
