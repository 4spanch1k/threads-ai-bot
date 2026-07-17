import { handleCronJob } from "../_shared/job_handler.ts";
import { runContentGenerator } from "./job.ts";

Deno.serve((request) => handleCronJob(request, "content-generator", runContentGenerator));
