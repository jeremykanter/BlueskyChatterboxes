# Bluesky Chatterboxes

A static web tool. Enter your Bluesky handle and see how often the accounts you follow post. Go to `https://jeremykanter.github.io/BlueskyChatterboxes/` to try it out.

## How it works

1. Resolves the input handle to a DID via `app.bsky.actor.getProfile`.
2. Pages through `app.bsky.graph.getFollows` to get the full follow list.
3. For each follow, pages `app.bsky.feed.getAuthorFeed` backward in time
   until it crosses the 90-day cutoff, counting original posts (reposts
   excluded; replies included).
4. Sorts by posts per day and renders a table.

Large follow lists take a while since each account requires its own paged feed
fetch.
