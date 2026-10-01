terraform {
  required_version = ">= 1.6, < 2.0"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.0" }
  }
}
provider "aws" { region = var.region }
variable "region" {
  type    = string
  default = "ap-southeast-1"
}
variable "name" {
  type    = string
  default = "two-server"
}
variable "ami_id" {
  type        = string
  description = "Verified Debian 12 or Ubuntu 24.04 amd64 AMI in this region"
}
variable "ssh_public_key" { type = string }
variable "ssh_cidrs" {
  type        = list(string)
  description = "Explicit operator/VPN ranges; SSH is never world-open"
  validation {
    condition     = length(var.ssh_cidrs) > 0 && alltrue([for c in var.ssh_cidrs : can(cidrnetmask(c)) && !endswith(c, "/0")])
    error_message = "Provide restricted IPv4 SSH CIDRs, not 0.0.0.0/0."
  }
}
variable "instance_type" {
  type    = string
  default = "t3.small"
}
resource "aws_vpc" "main" {
  cidr_block           = "10.72.0.0/16"
  enable_dns_hostnames = true
  tags                 = { Name = var.name }
}
resource "aws_subnet" "main" {
  vpc_id     = aws_vpc.main.id
  cidr_block = "10.72.1.0/24"
}
resource "aws_internet_gateway" "main" { vpc_id = aws_vpc.main.id }
resource "aws_route_table" "main" {
  vpc_id = aws_vpc.main.id
  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }
}
resource "aws_route_table_association" "main" {
  subnet_id      = aws_subnet.main.id
  route_table_id = aws_route_table.main.id
}
resource "aws_security_group" "main" {
  name   = var.name
  vpc_id = aws_vpc.main.id
  ingress {
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = var.ssh_cidrs
  }
  ingress {
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = var.web_cidrs
  }
  ingress {
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = var.web_cidrs
  }
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}
resource "aws_key_pair" "operator" {
  key_name   = var.name
  public_key = var.ssh_public_key
}
resource "aws_instance" "main" {
  ami                     = var.ami_id
  instance_type           = var.instance_type
  subnet_id               = aws_subnet.main.id
  vpc_security_group_ids  = [aws_security_group.main.id]
  key_name                = aws_key_pair.operator.key_name
  disable_api_termination = true
  metadata_options {
    http_tokens                 = "required"
    http_put_response_hop_limit = 1
  }
  root_block_device {
    volume_size = 30
    volume_type = "gp3"
    encrypted   = true
  }
  tags = { Name = var.name }
  lifecycle { prevent_destroy = true }
}
resource "aws_eip" "main" {
  domain     = "vpc"
  instance   = aws_instance.main.id
  depends_on = [aws_internet_gateway.main]
}
output "origin_ip" { value = aws_eip.main.public_ip }
output "ssh_host" { value = aws_eip.main.public_ip }

# https://www.cloudflare.com/ips-v4/ — review changes before applying.
variable "web_cidrs" {
  type    = list(string)
  default = ["173.245.48.0/20", "103.21.244.0/22", "103.22.200.0/22", "103.31.4.0/22", "141.101.64.0/18", "108.162.192.0/18", "190.93.240.0/20", "188.114.96.0/20", "197.234.240.0/22", "198.41.128.0/17", "162.158.0.0/15", "104.16.0.0/13", "104.24.0.0/14", "172.64.0.0/13", "131.0.72.0/22"]
}
