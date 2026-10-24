# Google Workspace read-only integration

## Scope of this phase

FlowWork can connect a Google account for an authenticated workspace member, list file metadata available to the Google app, and explicitly preview text from a selected supported file. Previews are read-only, in-memory, limited to 256 KiB, and are not saved to task history or sent to the workflow planner. Binary files such as PDFs/images remain metadata-only in this phase. FlowWork does not create/update/delete/share Drive files, access Gmail, send email, or execute a workflow by itself.

The provider adapter uses:
- Google OAuth authorization-code flow with state and PKCE S256.
- Offline access so the server can refresh short-lived access tokens.
- The limited `drive.file` Drive scope, plus OpenID/email/profile for identifying the connected account.
- A read-only Drive `files.list` request with a fixed query and explicit metadata fields.
- A user-triggered preview action that re-fetches metadata, checks `capabilities.canDownload`, exports Google Docs/Slides as plain text, Google Sheets as first-sheet CSV, and accepts only supported text files. Preview responses are limited to 256 KiB and never written to database/logs.

Google's `drive.file` scope is intentionally used instead of broad Drive-wide read access. The list only includes files that Google makes available to this application/account; it is not a mirror of the user's entire Drive.

## Required server configuration

Configure these as **Supabase Edge Function secrets**:

- `FLOWWORK_GOOGLE_CLIENT_ID`
- `FLOWWORK_GOOGLE_CLIENT_SECRET`
- `FLOWWORK_GOOGLE_REDIRECT_URI` — must exactly match the redirect URI registered in the Google OAuth client; for a deployed Supabase project it is typically `https://<project-ref>.supabase.co/functions/v1/google-workspace`.
- `FLOWWORK_GOOGLE_APP_REDIRECT_URL` — the trusted FlowWork frontend URL to return to after OAuth. It must be HTTPS, or localhost during local development, and has no query string or fragment in the server-side setting.

The project also needs its existing `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` secrets for the Edge Function. Do not put a Google client secret, refresh token, or service-role key into `VITE_*` variables or browser code.

## Secret and state storage

- OAuth state hashes and PKCE verifier references are saved in `google_workspace_oauth_states`; records expire after ten minutes and are atomically marked consumed before the callback processes them.
- The PKCE verifier and Google refresh token are stored in Supabase Vault. The workspace tables keep only the Vault secret UUID.
- Vault read/write/delete RPCs are service-role only. OAuth-state rows are also service-role only.
- Connection metadata is stored per workspace/user. Authenticated users can read only their own connection row when they remain a workspace member.
- Disconnect removes the saved connection and deletes the refresh-token secret; cleanup failures return a cleanup-pending flag without exposing token data.

## API and UI

The `google-workspace` Edge Function exposes these POST actions after verifying the user's Supabase bearer token and workspace membership:
- `connect` — creates expiring state and PKCE data, then returns a Google authorization URL.
- `status` — reports whether the current user has a connection and, when connected, their Google account email.
- `list_files` — refreshes the access token server-side and returns file IDs, names, MIME types, modification times, safe Drive links, and a server-derived preview-availability flag.
- `preview_file` — previews a file ID explicitly selected by the user. The server validates the Google metadata, MIME type, and download capability before exporting/downloading text to the browser. It rejects binary/unsupported files and content over 256 KiB.
- `disconnect` — removes the current user's connection.

The GET endpoint is reserved for Google's OAuth redirect callback and accepts only a valid, single-use state. The frontend validates the authorization origin and permitted link hosts. Metadata listing does not fetch content. Preview is an explicit separate action; returned text is rendered as escaped text in a bounded panel and remains only in current page state. Google Sheets previews export the first worksheet only.

## Deployment checklist

1. Create/configure a Google OAuth web client and register the exact function redirect URI.
2. Configure the four Google secrets on the Supabase project.
3. Deploy the migration, Edge Function and frontend together.
4. Run the OAuth callback in a test workspace, verify the expected consent scopes, and confirm that disconnect removes the saved connection.
5. Verify workspace membership revocation prevents further listing and that refresh token revocation requires reconnecting.

No live provider access occurs until an authorized user chooses Connect and grants the requested consent.
