# Security Policy

## Reporting

Do not open a public issue for a vulnerability that exposes credentials, private data, arbitrary command execution, unsafe filesystem access, or an authentication bypass. Contact the repository owner privately through GitHub first.

## Secrets

This repository must not contain npm tokens, GitHub tokens, API keys, `.env` contents, private keys, captured login output, or user Session data. Examples use obvious placeholders only.

## Release integrity

Normal releases use npm Trusted Publishing/OIDC from the exact `release.yml` workflow and the protected `npm-publish` GitHub Environment. An unprivileged job builds and tests the reviewed commit, uploads a SHA-1/SHA-512-recorded tarball, and the OIDC job checks out no source, installs no project dependencies, disables package caching, pins `https://registry.npmjs.org/`, verifies the artifact, and publishes it with lifecycle scripts disabled. A rerun accepts an existing version only when its registry integrity equals the verified artifact.

## This plugin's specific surface

- **API key**: read per operation from the DSH credentials service (`AGNES_API_KEY`) or the
  environment; never persisted in the plugin's configuration, its generation index, its logs, or any
  response to the browser. An upstream media URL on a third-party host is downloaded **without** the
  key, so a CDN never receives it.
- **Network egress**: `baseUrl` (default `https://apihub.agnes-ai.com/v1`) and the media URLs it
  returns. Reference media must be public HTTPS or `data:` URIs; loopback and private-network
  addresses are refused before a request is sent.
- **Filesystem**: one owned directory (`$DSH_HOME/agnes-studio` by default) holding `index.json` and
  `media/`. Artifact names are random UUIDs and every read re-validates the id shape, so a crafted id
  cannot address a file outside `media/`.
- **Browser transport**: both the RPC route and the media route sit inside DSH Connection's
  `/api` fence (Host/Origin check plus browser-session authentication); generated media is not
  world-readable.

## Supported versions

Until the first stable release, only the latest published version receives security fixes unless a release note states otherwise.
