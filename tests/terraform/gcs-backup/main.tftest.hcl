mock_provider "google" {}
variables {
  project         = "example-project"
  region          = "europe-west1"
  server_name     = "reader"
  service_account = "reader@example-project.iam.gserviceaccount.com"
}
run "archive_backup_only" {
  command = plan
  assert {
    condition     = google_storage_bucket.backup.name == "example-project-europe-west1-reader-2server-backup" && google_storage_bucket.backup.location == "EUROPE-WEST1" && google_storage_bucket.backup.storage_class == "ARCHIVE"
    error_message = "Backup storage must use Archive in the VM region with the configured server name."
  }
  assert {
    condition     = google_storage_bucket.backup.uniform_bucket_level_access && google_storage_bucket.backup.public_access_prevention == "enforced" && !google_storage_bucket.backup.force_destroy
    error_message = "Backups must be private and must not allow forced destruction."
  }
  assert {
    condition     = length(google_storage_bucket_iam_member.backup) == 2
    error_message = "Only object create/read grants are needed."
  }
  assert {
    condition     = one(one(google_storage_bucket.backup.lifecycle_rule).condition).age == 7 && one(one(google_storage_bucket.backup.lifecycle_rule).action).type == "Delete" && one(google_storage_bucket.backup.soft_delete_policy).retention_duration_seconds == 0
    error_message = "Backups must expire after seven days, without an extra soft-delete window."
  }
}
run "configured_retention" {
  command = plan
  variables { retention_days = 730 }
  assert {
    condition     = one(one(google_storage_bucket.backup.lifecycle_rule).condition).age == 730
    error_message = "Retention must be configurable independently of the backup interval."
  }
}
