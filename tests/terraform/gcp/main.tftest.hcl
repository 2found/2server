mock_provider "google" {}
variables { project = "unit-test-project" }
run "default_protection" {
  command = plan
  assert {
    condition     = google_compute_instance.main.deletion_protection
    error_message = "VM deletion protection must default on."
  }
  assert {
    condition     = google_compute_instance.main.shielded_instance_config[0].enable_secure_boot && google_compute_instance.main.metadata["enable-oslogin"] == "TRUE"
    error_message = "VM boot and SSH identity must be protected by default."
  }
  assert {
    condition     = google_compute_firewall.ssh.source_ranges == toset(["35.235.240.0/20"]) && google_compute_firewall.deny_other_ingress.priority > google_compute_firewall.ssh.priority && google_compute_firewall.deny_other_ingress.priority < 65534
    error_message = "IAP must remain reachable while a targeted deny overrides permissive default-network rules."
  }
}
run "reject_world_open_web" {
  command = plan
  variables { web_cidrs = ["0.0.0.0/0"] }
  expect_failures = [var.web_cidrs]
}
run "scoped_workload_access" {
  command = plan
  variables {
    workload_access = {
      secrets               = ["app-secret"]
      buckets               = { app-data = "roles/storage.objectUser" }
      artifact_repositories = { images = { location = "asia-southeast1", repository = "images" } }
      sign_blobs_as_self    = true
    }
  }
  assert {
    condition     = contains(keys(google_project_service.required), "iamcredentials.googleapis.com") && contains(keys(google_project_service.required), "secretmanager.googleapis.com") && contains(keys(google_project_service.required), "artifactregistry.googleapis.com")
    error_message = "Enable the APIs needed by the explicitly declared workload grants."
  }
}
run "reject_bucket_admin" {
  command = plan
  module { source = "./access" }
  variables {
    service_account_email = "test-vm@unit-test-project.iam.gserviceaccount.com"
    access                = { buckets = { app-data = "roles/storage.admin" } }
  }
  expect_failures = [var.access]
}
run "access_module_defaults_empty" {
  command = plan
  module { source = "./access" }
  variables { service_account_email = "test-vm@unit-test-project.iam.gserviceaccount.com" }
  assert {
    condition     = length(google_secret_manager_secret_iam_member.read) == 0 && length(google_storage_bucket_iam_member.objects) == 0 && length(google_service_account_iam_member.sign_self) == 0 && length(google_artifact_registry_repository_iam_member.pull) == 0 && length(google_pubsub_topic_iam_member.publish) == 0 && length(google_pubsub_subscription_iam_member.consume) == 0
    error_message = "A VM must receive no workload permissions unless resources are explicitly declared."
  }
}
run "signing_cannot_target_other_accounts" {
  command = plan
  module { source = "./access" }
  variables {
    service_account_email = "test-vm@unit-test-project.iam.gserviceaccount.com"
    access = {
      sign_blobs_as_self = true
      secrets            = ["app-secret"]
      buckets            = { app-data = "roles/storage.objectUser" }
    }
  }
  assert {
    condition     = google_service_account_iam_member.sign_self[0].service_account_id == "projects/unit-test-project/serviceAccounts/test-vm@unit-test-project.iam.gserviceaccount.com" && google_service_account_iam_member.sign_self[0].member == "serviceAccount:test-vm@unit-test-project.iam.gserviceaccount.com"
    error_message = "URL signing must be granted only on the VM service account itself."
  }
  assert {
    condition     = google_secret_manager_secret_iam_member.read["app-secret"].secret_id == "app-secret" && google_storage_bucket_iam_member.objects["app-data"].bucket == "app-data"
    error_message = "Secret and storage grants must be bound to their named resource."
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
