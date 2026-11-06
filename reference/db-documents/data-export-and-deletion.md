# Data Export & Deletion

Example Cloud lets workspace owners export their data, transfer ownership, and permanently delete accounts in line with GDPR and similar privacy laws.

## Full Workspace Export (JSON / CSV)

Owners and users with the **Data Admin** role can export the entire workspace.

### Starting an export

1. Open **Settings → Data → Export**.
2. Choose format: **JSON** (complete nested objects) or **CSV** (flattened tables for sheets).
3. Optionally include attachments (files uploaded to records). Large attachment bundles are delivered as a separate ZIP.
4. Click **Start export**.

Exports usually finish within 15 minutes for workspaces under 5 GB. You receive an email with a time-limited download link (valid 72 hours). For larger workspaces, contact support@examplecloud.example to schedule an offline export to S3 or GCS.

### What the export contains

- Users and role assignments
- Projects, records, comments, and activity history
- API keys metadata (secrets are never exported)
- Billing history summaries
- Webhook endpoint configuration (secrets redacted)

## Transferring Organization Ownership

Only the current **Organization Owner** can transfer ownership. The recipient must already be a member of the workspace.

### Transfer steps

1. Open **Settings → Members**.
2. Find the target member and open the overflow menu → **Make organization owner**.
3. Confirm with the owner's password or SSO re-auth.
4. The previous owner is demoted to **Admin** automatically.

Ownership transfer is immediate and irreversible without a second transfer. Billing responsibility moves with ownership. If the owner has left the company and no one can access their account, email legal@examplecloud.example with proof of authority; transfers via support require notarized documentation for Enterprise accounts.

## Permanent GDPR Account Deletion

Individuals and workspace owners can request permanent deletion under GDPR (Right to Erasure) and similar regulations.

### User-level deletion

A user can delete their own account under **Settings → Account → Delete account**. Personal profile data is removed. Records they created in shared workspaces remain attributed to "Deleted User" unless a workspace admin reassigns them first.

### Workspace-level deletion

The Organization Owner can delete the entire workspace under **Settings → Data → Delete workspace**. This schedules irreversible removal of all workspace data.

## 30-Day Grace Window

After a deletion request is confirmed, Example Cloud keeps a soft-deleted copy for a **30-day grace window**. During those 30 days:

- The owner can cancel deletion from the confirmation email link or by contacting support@examplecloud.example.
- Logins to the deleted workspace are blocked.
- Exports are no longer available once deletion is scheduled.

On day 31 the data is purged from primary storage and replicas. Backup tapes roll off on their normal 90-day cycle and are not restored for deleted workspaces. After purge, recovery is impossible. For legal holds, contact legal@examplecloud.example **before** confirming deletion.
