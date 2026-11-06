# SSO & Authentication

Example Cloud supports password login, optional 2FA, and enterprise Single Sign-On via SAML 2.0. This guide covers IdP setup, certificate rotation, and account recovery.

## SAML 2.0 Setup

SAML SSO is available on Growth and Enterprise plans. Example Cloud acts as the Service Provider (SP). Your identity provider (Okta, Azure AD, Google Workspace, OneLogin, etc.) is the IdP.

### SP metadata values

Use these values when configuring your IdP application:

- **Entity ID / Audience**: `https://auth.examplecloud.example/saml/metadata`
- **ACS URL / Reply URL**: `https://auth.examplecloud.example/saml/acs`
- **NameID format**: email address (`urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress`)

Map the IdP attributes `email`, `firstName`, and `lastName` to the corresponding SAML claims. Just-in-time provisioning creates the user on first successful login when SSO is enforced.

### Uploading IdP metadata XML

1. In Example Cloud, open **Settings → Security → SSO**.
2. Click **Upload IdP metadata XML** and select the metadata file exported from your IdP (often named `metadata.xml`).
3. Confirm the Entity ID and SSO URL parsed from the file look correct.
4. Toggle **Enforce SSO for this workspace** only after a test login succeeds.

You can also paste the IdP SSO URL and X.509 certificate manually if your IdP does not provide a full metadata XML download.

## Certificate Rotation (SAML_CERT_EXPIRED)

IdP signing certificates expire. When Example Cloud cannot validate the assertion signature, login fails with error code **SAML_CERT_EXPIRED**.

### Symptoms of SAML_CERT_EXPIRED

Users see "Sign-in failed: SAML_CERT_EXPIRED" on the login page. Admins receive an email titled "SSO certificate expired or invalid." Password login (if still enabled) continues to work during the outage.

### Rotating the certificate

1. In your IdP, generate or download the new signing certificate (keep the old one active during overlap if the IdP supports dual certs).
2. In Example Cloud, open **Settings → Security → SSO → Certificates**.
3. Click **Replace certificate** and paste the new PEM-encoded X.509 certificate, or re-upload an updated IdP metadata XML that contains the new cert.
4. Click **Test SSO login** in an incognito window before enforcing the change for everyone.

After a successful test, remove the expired certificate. Certificate updates usually propagate within 60 seconds. If SAML_CERT_EXPIRED persists, verify the certificate chain and that the IdP is signing with the same cert you uploaded.

## 2FA Backup Codes & Recovery

Any user can enable time-based one-time passwords (TOTP) under **Settings → Security → Two-factor authentication**. When 2FA is enabled, Example Cloud shows a one-time list of **10 backup codes**.

### Storing backup codes

Each backup code can be used once. Download or print them and store them offline. Example Cloud never displays the full list again after you leave the setup screen.

### Recovering a locked account

If a user loses their authenticator app and all backup codes:

1. Another workspace admin opens **Settings → Members**, finds the user, and clicks **Reset 2FA**.
2. The user signs in with password (or SSO) and is prompted to enroll 2FA again.

If the only admin is locked out and SSO is not configured, email security@examplecloud.example from the workspace owner's verified email with government ID verification. Recovery typically completes within one business day.
