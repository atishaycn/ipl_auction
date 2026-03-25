# IPL Auction Vercel Setup Instructions

This repo is now structured to run on Vercel with Supabase as the backing store.
The remaining setup is mostly platform configuration.

## 1. Create the Supabase project

1. Create a new project in Supabase.
2. Copy the project values from the Supabase dashboard:
   - `Project URL`
   - `service_role` key
3. Keep the `service_role` key private. It should only be used as a Vercel server environment variable.

## 2. Create the database table

Run the SQL in [`supabase/schema.sql`](./supabase/schema.sql) in the Supabase SQL editor.

This creates the `rooms` table used by the backend API.

If you want a clean start, run the schema against an empty database.
If you already have data, back it up first because the room state is stored as JSON in that table.

## 3. Set environment variables in Vercel

In the Vercel project settings, add:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

These values must be available to the serverless API functions.

Do not expose the `service_role` key in any client-side code.

## 4. Confirm Vercel routing

The repo includes [`vercel.json`](./vercel.json) with rewrites for:

- `/room/:id`
- `/public/:id`

This is what makes browser refresh work on those routes.

The API routes live under `api/rooms/*` and are deployed automatically by Vercel.

## 5. Deploy

1. Push the repo to the branch connected to your Vercel project.
2. Trigger a redeploy from Vercel.
3. Open the deployed site and create a room.
4. Copy the admin link and invite link that the UI shows.

## 6. Smoke test the deployed app

Check these flows after deploy:

- Create a room from the landing page.
- Open the room URL directly in a fresh tab.
- Refresh `/room/<ROOM_ID>` and `/public/<ROOM_ID>`.
- Add an owner, claim a seat, and place a bid.
- Confirm room updates appear after polling.
- Confirm the state survives a redeploy.

## 7. Local development notes

- `node server.js` still exists for local testing.
- If Supabase env vars are present locally, the API layer can use Supabase.
- If they are missing locally, the app falls back to the file-based room store.

## 8. Common failure points

- Missing `SUPABASE_URL` or `SUPABASE_SERVICE_ROLE_KEY`.
- Forgetting to run the SQL schema before the first deploy.
- Opening `/room/:id` directly without the Vercel rewrite in place.
- Expecting instant push updates instead of the polling loop.

