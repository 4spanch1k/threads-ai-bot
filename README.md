# Threads AI Bot

Automation agent for monitoring Threads interactions, classifying incoming items, and publishing or replying through free-tier infrastructure.

Planned stack:

- Cloudflare Workers for the Meta webhook receiver
- Supabase for persistence
- GitHub Actions for background processing and scheduled jobs
- Groq for low-confidence classification cases
- Telegram for operational alerts
