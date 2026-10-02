terraform {
  required_version = ">= 1.6, < 2.0"
  required_providers {
    google = { source = "hashicorp/google", version = "~> 6.0" }
  }
}
provider "google" { project = var.project }
variable "project" { type = string }
variable "region" { type = string }
variable "server_name" { type = string }
variable "service_account" { type = string }
variable "retention_days" {
  type    = number
  default = 7
  validation {
    condition     = var.retention_days >= 1 && var.retention_days <= 36500 && floor(var.retention_days) == var.retention_days
    error_message = "Backup retention must be a whole number of days between 1 and 36500."
  }
}
variable "storage_class" {
  type    = string
  default = "STANDARD"
  validation {
    condition     = contains(["STANDARD", "NEARLINE", "COLDLINE", "ARCHIVE"], var.storage_class)
    error_message = "Unsupported GCS storage class."
  }
}
resource "google_storage_bucket" "backup" {
  name                        = "${var.project}-${var.region}-${var.server_name}-2server-backup"
  location                    = upper(var.region)
  storage_class               = var.storage_class
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = false
  lifecycle_rule {
    condition { age = var.retention_days }
    action { type = "Delete" }
  }
  # Lifecycle deletion is final, without a second soft-delete retention window.
  soft_delete_policy { retention_duration_seconds = 0 }
  labels = {
    managed_by  = "2server"
    server_name = var.server_name
  }
  lifecycle { prevent_destroy = true }
}
resource "google_storage_bucket_iam_member" "backup" {
  for_each = toset(["roles/storage.objectCreator", "roles/storage.objectViewer"])
  bucket   = google_storage_bucket.backup.name
  role     = each.value
  member   = "serviceAccount:${var.service_account}"
}
output "backup_storage" {
  value = {
    bucket         = google_storage_bucket.backup.name
    region         = var.region
    storage_class  = google_storage_bucket.backup.storage_class
    retention_days = var.retention_days
    destination    = "gs://${google_storage_bucket.backup.name}/postgres"
  }
}
