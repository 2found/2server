mock_provider "google" {}
variables { project = "unit-test-project" }
run "default_protection" {
  command = plan
  assert {
    condition     = google_compute_instance.main.deletion_protection
    error_message = "VM deletion protection must default on."
  }
}
run "separate_data_disk_and_backup_identity" {
  command = plan
  variables {
    data_disks    = { database = { size_gb = 50 } }
    backup_bucket = "example-backups"
  }
  assert {
    condition     = google_compute_disk.data["database"].size == 50 && google_compute_attached_disk.data["database"].device_name == "database"
    error_message = "Dedicated data disks must be attached with stable device names."
  }
  assert {
    condition     = length(google_storage_bucket_iam_member.backup) == 2
    error_message = "Backups require object creator and reader, without delete permissions."
  }
}
