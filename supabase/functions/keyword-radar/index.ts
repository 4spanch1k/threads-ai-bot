import { handleCronJob } from "../_shared/job_handler.ts";
import { runKeywordRadar } from "./job.ts";

Deno.serve((request) => handleCronJob(request, "keyword-radar", runKeywordRadar));
