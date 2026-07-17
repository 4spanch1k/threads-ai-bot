import { handleCronJob } from "../_shared/job_handler.ts";
import { runInteractionPoller } from "./job.ts";

Deno.serve((request) => handleCronJob(request, "interaction-poller", runInteractionPoller));
