# E2E Tests

End-to-end tests for moltworker that deploy to real Cloudflare infrastructure.

## Why Cloud E2E?

Local `wrangler dev` doesn't support several features we need to test:
- R2 bucket mounting and persistence
- Container sandbox initialization
- Cloudflare Access authentication
- Actual network latency and timeouts

## Architecture

```
test/e2e/
  _setup.txt                  # Starts server + browser + video
  _teardown.txt               # Stops everything + cleans up
  pairing_and_conversation.txt # Device pairing + chat test
  r2_persistence.txt          # R2 sync + restore test
  fixture/
    curl-auth                 # curl wrapper with Access headers
    pw                        # playwright-cli wrapper (error detection)
    start-browser             # Opens browser with Access headers
    stop-browser              # Stops browser session
    start-server              # Delegates to server/start
    stop-server               # Delegates to server/stop
    server/
      main.tf                 # Terraform: service token + R2 bucket
      variables.tf            # Terraform variables
      outputs.tf              # Terraform outputs
      start                   # Orchestrator: terraform + deploy + access
      stop                    # Cleanup: delete everything
      deploy                  # Build + wrangler deploy + secrets
      create-access-app       # CF Access app + policies
      delete-worker            # wrangler delete
      terraform-apply         # terraform init + apply
      terraform-destroy       # Empty R2 + terraform destroy
      wait-ready              # Poll until HTTP 200
```

## Setup

1. Copy `.dev.vars.example` to `.dev.vars` and fill in credentials
2. Install dependencies: `npm install`
3. Install [cctr](https://github.com/joseluisq/cctr): `brew install cctr` or `cargo install cctr`
4. Install playwright-cli: `npm install -g @playwright/cli`

## Running

```bash
# Run all e2e tests
cctr test/e2e/

# Verbose mode
cctr test/e2e/ -v

# Run specific test
cctr test/e2e/ -p pairing

# Run with headed browser
PLAYWRIGHT_HEADED=1 cctr test/e2e/
```

## CI

E2E tests run in GitHub Actions with:
- Terraform provisioning isolated resources per run
- Automatic cleanup even on failure
- Video recording uploaded as artifacts
- PR comments with test results

## Test Flow

1. **terraform-apply**: Creates service token + R2 bucket
2. **deploy**: Builds and deploys worker with unique name
3. **create-access-app**: Protects worker with CF Access
4. **wait-ready**: Polls until container cold-starts (1-2 min)
5. **Tests run** via playwright-cli in headless browser
6. **Teardown**: Deletes worker, Access app, R2 bucket, service token

Videos are saved to `/tmp/moltworker-e2e-videos/` after each run.
