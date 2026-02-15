variable "cloudflare_api_token" {
  type        = string
  description = "Cloudflare API token with Access and R2 permissions"
  sensitive   = true
}

variable "cloudflare_account_id" {
  type        = string
  description = "Cloudflare account ID"
}

variable "workers_subdomain" {
  type        = string
  description = "Your workers.dev subdomain (e.g., 'myaccount' for myaccount.workers.dev)"
}

variable "test_run_id" {
  type        = string
  description = "Unique identifier for this test run (e.g., PR number or timestamp)"
  default     = "local"
}
