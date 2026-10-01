mock_provider "aws" {}
variables {
  ami_id         = "ami-0123456789abcdef0"
  ssh_public_key = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAITestFixtureOnly"
  ssh_cidrs      = ["192.0.2.0/24"]
}
run "default_protection" {
  command = plan
  assert {
    condition     = aws_instance.main.disable_api_termination && aws_instance.main.metadata_options[0].http_tokens == "required"
    error_message = "Termination protection and IMDSv2 must default on."
  }
}
run "separate_data_disk_and_backup_identity" {
  command = plan
  variables {
    data_disks    = { database = { size_gb = 50, device = "/dev/sdf" } }
    backup_bucket = "example-backups"
  }
  assert {
    condition     = aws_ebs_volume.data["database"].encrypted && aws_ebs_volume.data["database"].size == 50
    error_message = "Database storage must be a separate encrypted volume."
  }
  assert {
    condition     = length(aws_iam_role.backup) == 1
    error_message = "The VM needs a scoped role for backup storage."
  }
}
