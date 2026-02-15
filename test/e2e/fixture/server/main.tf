terraform {
  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "~> 5.0"
    }
  }
}

provider "cloudflare" {
  api_token = var.cloudflare_api_token
}

# Service token for Access authentication
resource "cloudflare_zero_trust_access_service_token" "e2e" {
  account_id = var.cloudflare_account_id
  name       = "moltbot-e2e-${var.test_run_id}"
  duration   = "8760h"
}

# R2 bucket for persistence testing
resource "cloudflare_r2_bucket" "e2e" {
  account_id = var.cloudflare_account_id
  name       = "moltbot-e2e-${var.test_run_id}"
  location   = "WNAM"
}

# NOTE: Access application is NOT managed by Terraform because it requires
# the worker to be deployed first (to set the domain). Instead, we use
# E2E_TEST_MODE + MOLTBOT_GATEWAY_TOKEN for authentication.
