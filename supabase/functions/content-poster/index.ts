import { handleCronJob } from "../_shared/job_handler.ts";
import { runContentPoster } from "./job.ts";

Deno.serve((request) => handleCronJob(request, "content-poster", runContentPoster));
