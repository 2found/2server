variable "workload_access" {
  description = "Resource-scoped workload permissions for this VM. See the access module; defaults to no permissions."
  type = object({
    secrets               = optional(set(string), [])
    buckets               = optional(map(string), {})
    artifact_repositories = optional(map(object({ location = string, repository = string })), {})
    pubsub_topics         = optional(set(string), [])
    pubsub_subscriptions  = optional(set(string), [])
    sign_blobs_as_self    = optional(bool, false)
  })
  default = {}
}

module "workload_access" {
  source                = "./access"
  depends_on            = [google_project_service.required]
  project               = var.project
  service_account_email = google_service_account.vm.email
  access                = var.workload_access
}
