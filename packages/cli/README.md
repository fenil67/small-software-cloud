# ssc — Utir CLI

Deploy and manage apps on [Utir](https://app.utir.dev) from your terminal.

## Install

```sh
npm install -g @utir/ssc
```

## Usage

```sh
# Save your API key
ssc login

# Deploy a local directory
ssc deploy ./my-app

# Deploy from GitHub
ssc deploy --github https://github.com/owner/repo

# Check deployment status
ssc status <deployment-id>

# Share an app with a team member
ssc share <app-id> user@example.com

# Revoke access
ssc unshare <app-id> user@example.com

# List who has access
ssc access <app-id>

# Permanently delete an app
ssc destroy <app-id>
```

## Configuration

Set `SSC_API_KEY` in your environment, or run `ssc login` to save a key to `~/.config/ssc/config.json`.

## License

UNLICENSED — proprietary software.
