---
name: secure-credentials
description: Rules for storing credentials that grant ongoing access to a real external account. Use before storing OAuth, API, or refresh tokens or API keys, and before building any banking, financial, or health integration.
---

# Secure credentials

- Encrypt OAuth/API tokens at rest: AES-256-GCM, key in a dedicated env var. Decrypt only in memory. Never log them.
- Raise the storage design with the user before building any banking, financial, or health integration.
- On disconnect, revoke the token with the provider too, not only locally.
