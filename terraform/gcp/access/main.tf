terraform {
  required_providers {
    google = { source = "hashicorp/google", version = ">= 5.0, < 7.0" }
  }
}

variable "project" { type = string }
variable "service_account_email" { type = string }
variable "access" {
  description = "Explicit workload grants on individual resources. Empty by default; never grants project-wide roles."
  type = object({
    secrets               = optional(set(string), [])
    buckets               = optional(map(string), {})
    artifact_repositories = optional(map(object({ location = string, repository = string })), {})
    pubsub_topics         = optional(set(string), [])
    pubsub_subscriptions  = optional(set(string), [])
    sign_blobs_as_self    = optional(bool, false)
  })
  default = {}
  validation {
    condition = alltrue([for role in values(var.access.buckets) : contains([
      "roles/storage.objectViewer", "roles/storage.objectCreator", "roles/storage.objectUser", "roles/storage.objectAdmin"
    ], role)])
    error_message = "Bucket access must use a storage object role, never bucket or project administration."
  }
}

locals { member = "serviceAccount:${var.service_account_email}" }

resource "google_secret_manager_secret_iam_member" "read" {
  for_each  = var.access.secrets
  project   = var.project
  secret_id = each.value
  role      = "roles/secretmanager.secretAccessor"
  member    = local.member
}
resource "google_storage_bucket_iam_member" "objects" {
  for_each = var.access.buckets
  bucket   = each.key
  role     = each.value
  member   = local.member
}
resource "google_artifact_registry_repository_iam_member" "pull" {
  for_each   = var.access.artifact_repositories
  project    = var.project
  location   = each.value.location
  repository = each.value.repository
  role       = "roles/artifactregistry.reader"
  member     = local.member
}
resource "google_pubsub_topic_iam_member" "publish" {
  for_each = var.access.pubsub_topics
  project  = var.project
  topic    = each.value
  role     = "roles/pubsub.publisher"
  member   = local.member
}
resource "google_pubsub_subscription_iam_member" "consume" {
  for_each     = var.access.pubsub_subscriptions
  project      = var.project
  subscription = each.value
  role         = "roles/pubsub.subscriber"
  member       = local.member
}
resource "google_service_account_iam_member" "sign_self" {
  count              = var.access.sign_blobs_as_self ? 1 : 0
  service_account_id = "projects/${var.project}/serviceAccounts/${var.service_account_email}"
  role               = "roles/iam.serviceAccountTokenCreator"
  member             = local.member
}
