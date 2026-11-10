# REQ-INT-018 — the OpenMap appliance: an Ubuntu Server VM image with Docker, the air-gap bundle's images loaded, and
# the first-boot and stack units. Built with QEMU on a connected Linux machine with KVM; the qcow2 is converted for
# VMware (VMDK, for an OVA) and Hyper-V (VHDX) by the post-processor. Every value is a variable.
#   packer init deploy/appliance && packer build -var bundle_dir=<bundle> -var openmap_version=<v> deploy/appliance
packer {
  required_plugins {
    qemu = {
      source  = "github.com/hashicorp/qemu"
      version = "~> 1.1"
    }
  }
}

variable "openmap_version" {
  type        = string
  description = "The air-gap bundle's version (its image tag)."
}

variable "bundle_dir" {
  type        = string
  description = "Output directory of deploy/airgap-bundle/build-bundle.sh."
}

variable "base_image_url" {
  type        = string
  description = "Ubuntu Server cloud image (qcow2)."
  default     = "https://cloud-images.ubuntu.com/releases/24.04/release/ubuntu-24.04-server-cloudimg-amd64.img"
}

variable "base_image_checksum" {
  type        = string
  description = "Checksum of the cloud image, e.g. file:<SHA256SUMS URL>."
  default     = "file:https://cloud-images.ubuntu.com/releases/24.04/release/SHA256SUMS"
}

variable "disk_size" {
  type        = string
  description = "Appliance disk: the images, the data volumes and backup sets."
  default     = "200G"
}

variable "memory_mb" {
  type    = number
  default = 16384
}

variable "cpus" {
  type    = number
  default = 8
}

variable "output_dir" {
  type    = string
  default = "dist/appliance"
}

variable "build_user" {
  type        = string
  description = "The user cloud-init creates for the build only; install.sh locks it at the end."
  default     = "packer"
}

variable "build_password" {
  type        = string
  sensitive   = true
  description = "That user's password for this build only (pass a fresh random value; it is locked in the image)."
}

source "qemu" "openmap" {
  iso_url          = var.base_image_url
  iso_checksum     = var.base_image_checksum
  disk_image       = true
  disk_size        = var.disk_size
  format           = "qcow2"
  accelerator      = "kvm"
  memory           = var.memory_mb
  cpus             = var.cpus
  headless         = true
  output_directory = var.output_dir
  vm_name          = "openmap-${var.openmap_version}.qcow2"
  cd_content = {
    "meta-data" = <<-EOT
      instance-id: openmap-build
      local-hostname: openmap
    EOT
    "user-data" = templatefile("${path.root}/cloud-init.pkrtpl", { user = var.build_user, password = var.build_password })
  }
  cd_label         = "cidata"
  ssh_username     = var.build_user
  ssh_password     = var.build_password
  ssh_timeout      = "30m"
  shutdown_command = "sudo shutdown -P now"
}

build {
  sources = ["source.qemu.openmap"]

  provisioner "file" {
    source      = "${var.bundle_dir}/"
    destination = "/tmp/openmap-bundle"
  }

  provisioner "file" {
    source      = "${path.root}/"
    destination = "/tmp/openmap-bundle/appliance"
  }

  provisioner "shell" {
    execute_command  = "sudo -E sh -c '{{ .Vars }} {{ .Path }}'"
    environment_vars = ["OPENMAP_VERSION=${var.openmap_version}", "OPENMAP_BUNDLE_DIR=/tmp/openmap-bundle", "OPENMAP_BUILD_USER=${var.build_user}"]
    script           = "${path.root}/install.sh"
  }

  post-processor "shell-local" {
    inline = [
      "qemu-img convert -O vmdk -o subformat=streamOptimized ${var.output_dir}/openmap-${var.openmap_version}.qcow2 ${var.output_dir}/openmap-${var.openmap_version}.vmdk",
      "qemu-img convert -O vhdx ${var.output_dir}/openmap-${var.openmap_version}.qcow2 ${var.output_dir}/openmap-${var.openmap_version}.vhdx",
    ]
  }
}
