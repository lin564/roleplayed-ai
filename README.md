# roleplayed.ai

Marketing site for RoleplayEd. Visitors can try one of five practice conversations with a live AI character, get feedback, and request a demo. **Log in** sends people to the app at `https://app.roleplayed.ai`.

It runs as one Cloudflare Worker:

- `public/` holds the static page (`index.html`) and character portraits.
- `src/worker.ts` serves the page and these API routes:
  - `GET /api/health` reports whether live replies are configured.
  - `POST /api/reply` returns the character's next line and updated trust score.
  - `POST /api/feedback` returns end-of-conversation scores and coaching.
  - `POST /api/contact` saves a demo request to the `LEADS` KV namespace.
- `src/characters.ts` holds each character's backstory and behaviour. It stays on the server, so visitors can't change how a character acts.

If live replies aren't configured, the page still works: characters answer the suggested opening lines from a short script, and the feedback is a simple summary.

## Safeguards on the public demo

- Each visitor (by IP) gets at most 20 API calls per minute per route (`DEMO_LIMITER` in `wrangler.toml`).
- A conversation is capped at 6 learner turns of up to 800 characters each, and must start with the character's scripted opening line.
- API calls are accepted only from the site's own pages (`Origin` check).

## Deploying

Every push to `main` deploys through `.github/workflows/deploy.yml`. Set these once under **Settings → Secrets and variables → Actions**:

| Name | Kind | Value |
|---|---|---|
| `CLOUDFLARE_API_TOKEN` | Secret | A Cloudflare API token with the **Edit Cloudflare Workers** template |
| `CLOUDFLARE_ACCOUNT_ID` | Secret | Your Cloudflare account ID (dashboard sidebar → Account ID) |
| `ANTHROPIC_API_KEY` | Secret | A Claude API key from console.anthropic.com |
| `CLAUDE_MODEL` | Variable | The Claude model ID that powers the characters |

Then run the **Deploy** workflow (Actions tab → Deploy → Run workflow). The site appears at `https://roleplayed-ai.<your-subdomain>.workers.dev`.

### Moving roleplayed.ai to this site

roleplayed.ai currently serves the app, so switch it over in this order:

1. Give the app its new address, `app.roleplayed.ai`, and add `https://app.roleplayed.ai` to `ALLOWED_ORIGINS` on the `roleplayed-one-api` Worker.
2. Remove whatever points roleplayed.ai at the app today: a redirect rule, a page rule, a DNS record, or a custom domain on the app's Pages project.
3. Uncomment the `routes` block in `wrangler.toml` and push. Cloudflare creates the DNS records and certificates for `roleplayed.ai` and `www.roleplayed.ai`.

## Local development

```sh
npm install
echo 'ANTHROPIC_API_KEY=sk-ant-...' > .dev.vars
npx wrangler dev --var CLAUDE_MODEL:<model-id>
```

Leave out `.dev.vars` to try the scripted fallback. `npm run check` type-checks and builds without deploying.

## Reading demo requests

Requests are stored in the `roleplayed-ai-leads` KV namespace as `lead:<timestamp>:<id>`. View them in the Cloudflare dashboard (Storage & Databases → KV), or run:

```sh
npx wrangler kv key list --binding LEADS --remote
```
