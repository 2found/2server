#!/bin/bash
set -euo pipefail
# Mock providers need Terraform >= 1.7; production roots remain compatible with 1.6.
root=$(cd "$(dirname "$0")/.." && pwd)
tool=${TERRAFORM_BIN:-terraform}
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
for provider in gcp aws gcs-backup; do
  dir="$work/$provider"
  mkdir -p "$dir/tests"
  cp "$root/terraform/$provider/"*.tf "$dir/"
  if [ "$provider" = gcp ]; then cp -R "$root/terraform/gcp/access" "$dir/access"; fi
  cp "$root/terraform/$provider/.terraform.lock.hcl" "$dir/"
  cp "$root/tests/terraform/$provider/"*.tftest.hcl "$dir/tests/"
  if [ -d "$root/terraform/$provider/.terraform/providers" ]; then
    mkdir -p "$dir/.terraform"
    ln -s "$root/terraform/$provider/.terraform/providers" "$dir/.terraform/providers"
  fi
  "$tool" -chdir="$dir" init -backend=false -input=false >/dev/null
  "$tool" -chdir="$dir" test
done
