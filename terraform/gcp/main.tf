terraform {
  required_version = ">= 1.6, < 2.0"
  required_providers {
    google = { source = "hashicorp/google", version = "~> 6.0" }
  }
}
provider "google" {
  project = var.project
  region  = var.region
}
variable "project" { type = string }
variable "region" {
  type    = string
  default = "asia-southeast1"
}
variable "zone" {
  type    = string
  default = "asia-southeast1-a"
}
variable "name" {
  type    = string
  default = "two-server"
}
variable "machine_type" {
  type    = string
  default = "e2-small"
}
variable "disk_gb" {
  type    = number
  default = 30
}
resource "google_compute_network" "main" {
  depends_on              = [google_project_service.required]
  name                    = var.name
  auto_create_subnetworks = false
}
resource "google_compute_subnetwork" "main" {
  name          = var.name
  ip_cidr_range = "10.72.0.0/24"
  region        = var.region
  network       = google_compute_network.main.id
}
resource "google_compute_address" "main" { name = var.name }
resource "google_service_account" "vm" {
  depends_on   = [google_project_service.required]
  account_id   = var.name
  display_name = "2server VM (no project-wide secret access)"
}
resource "google_compute_firewall" "web" {
  name          = "${var.name}-web"
  network       = google_compute_network.main.name
  source_ranges = var.web_cidrs
  target_tags   = [var.name]
  allow {
    protocol = "tcp"
    ports    = ["80", "443"]
  }
}
resource "google_compute_firewall" "ssh" {
  name          = "${var.name}-iap"
  network       = google_compute_network.main.name
  source_ranges = ["35.235.240.0/20"]
  target_tags   = [var.name]
  allow {
    protocol = "tcp"
    ports    = ["22"]
  }
}
resource "google_compute_instance" "main" {
  name                = var.name
  machine_type        = var.machine_type
  zone                = var.zone
  deletion_protection = !var.allow_destroy
  tags                = [var.name]
  boot_disk {
    initialize_params {
      image = "debian-cloud/debian-12"
      size  = var.disk_gb
      type  = "pd-balanced"
    }
  }
  network_interface {
    subnetwork = google_compute_subnetwork.main.id
    access_config { nat_ip = google_compute_address.main.address }
  }
  service_account {
    email  = google_service_account.vm.email
    scopes = ["cloud-platform"]
  }
  metadata = {
    enable-oslogin           = "TRUE"
    block-project-ssh-keys   = "TRUE"
    disable-legacy-endpoints = "TRUE"
  }
  lifecycle { ignore_changes = [attached_disk] }
  shielded_instance_config {
    enable_secure_boot          = true
    enable_vtpm                 = true
    enable_integrity_monitoring = true
  }

}
output "origin_ip" { value = google_compute_address.main.address }
output "name" { value = var.name }
output "ssh" {
  value = { kind = "gcp", project = var.project, zone = var.zone, instance = var.name, iap = true }
}

# https://www.cloudflare.com/ips-v4/ — review changes before applying.
variable "web_cidrs" {
  type    = list(string)
  default = ["173.245.48.0/20", "103.21.244.0/22", "103.22.200.0/22", "103.31.4.0/22", "141.101.64.0/18", "108.162.192.0/18", "190.93.240.0/20", "188.114.96.0/20", "197.234.240.0/22", "198.41.128.0/17", "162.158.0.0/15", "104.16.0.0/13", "104.24.0.0/14", "172.64.0.0/13", "131.0.72.0/22"]
}

resource "google_project_service" "required" {
  for_each           = toset(["compute.googleapis.com", "iam.googleapis.com", "iap.googleapis.com", "oslogin.googleapis.com"])
  service            = each.value
  disable_on_destroy = false
}

# Deletion needs a deliberate update with allow_destroy=true before destroy.
variable "allow_destroy" {
  type        = bool
  default     = false
  description = "Disable VM deletion protection only for an explicitly planned retirement."
}
variable "backup_bucket" {
  type        = string
  default     = null
  description = "Existing dedicated backup bucket; grants this VM read/write object access. Retention/versioning is managed by the bucket owner."
}

variable "data_disks" {
  type    = map(object({ size_gb = number, type = optional(string, "pd-balanced") }))
  default = {}
  validation {
    condition     = alltrue([for n, d in var.data_disks : can(regex("^[a-z][a-z0-9-]{0,47}$", n)) && d.size_gb >= 10])
    error_message = "Data disks require safe names and at least 10 GB."
  }
}
resource "google_compute_disk" "data" {
  for_each = var.data_disks
  name     = "${var.name}-${each.key}"
  zone     = var.zone
  size     = each.value.size_gb
  type     = each.value.type
  lifecycle { prevent_destroy = true }
}
resource "google_compute_attached_disk" "data" {
  for_each    = google_compute_disk.data
  disk        = each.value.id
  instance    = google_compute_instance.main.id
  device_name = each.key
}
resource "google_storage_bucket_iam_member" "backup" {
  for_each = var.backup_bucket == null ? toset([]) : toset(["roles/storage.objectCreator", "roles/storage.objectViewer"])
  bucket   = var.backup_bucket
  role     = each.value
  member   = "serviceAccount:${google_service_account.vm.email}"
}

output "data_disks" {
  value = { for name, d in google_compute_disk.data : name => {
    name      = name
    provider  = { kind = "gcp", project = var.project, zone = var.zone, disk = d.name }
    device    = "/dev/disk/by-id/google-${name}"
    mountPath = "/mnt/${name}"
  } }
}
