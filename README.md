# Most Active Bluesky Follows

A static web tool: enter a Bluesky handle, get a list of the accounts they
follow ranked by posts per day over the last 3 months.

## Run

It's a static page — open `index.html` in a browser, or serve the directory:

```
python3 -m http.server 8000
# then visit http://localhost:8000
```

No build step, no backend, no auth. All data is fetched from the public
Bluesky AppView at `https://public.api.bsky.app`.

## How it works

1. Resolves the input handle to a DID via `app.bsky.actor.getProfile`.
2. Pages through `app.bsky.graph.getFollows` to get the full follow list.
3. For each follow, pages `app.bsky.feed.getAuthorFeed` backward in time
   until it crosses the 90-day cutoff, counting original posts (reposts
   excluded; replies included).
4. Sorts by posts per day and renders a table.

Large follow lists take a while — each account requires its own paged feed
fetch. Concurrency is capped at 6 in-flight requests with 429 backoff.

## Planned features

- Sparklines per account showing the posting timeline
- Configurable time window (1 week / 1 month / 6 months / 1 year / all time)
- Toggles to include or exclude replies and reposts
