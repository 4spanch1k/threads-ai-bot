import { handleCronJob } from "../_shared/job_handler.ts";
import { runInteractionProcessor } from "./job.ts";

Deno.serve((request) => handleCronJob(request, "interaction-processor", runInteractionProcessor));
