terraform {
  required_version = ">= 1.9"
  required_providers {
    kubernetes = {
      source  = "hashicorp/kubernetes"
      version = "~> 2.35"
    }
    helm = {
      source  = "hashicorp/helm"
      version = "~> 2.17"
    }
  }
}

variable "kube_context" {
  description = "kubeconfig context of the target cluster (kind-davra-kind for local validation)"
  type        = string
  default     = "kind-davra-kind"
}

variable "namespace" {
  type    = string
  default = "davrabox"
}

variable "public_host" {
  description = "Host users reach; also the Keycloak issuer host"
  type        = string
}

variable "realm_json_path" {
  description = "Path to the Keycloak realm export used for the dev Keycloak"
  type        = string
  default     = "../../../keycloak/davrabox-realm.json"
}

variable "secret_values" {
  description = "Values for the davrabox-secrets Secret. Supply via TF_VAR or a secret manager, never commit them."
  type        = map(string)
  sensitive   = true

  validation {
    condition = alltrue([
      for k in ["POSTGRES_PASSWORD", "APP_DB_PASSWORD", "KEYCLOAK_ADMIN_PASSWORD", "LIVEKIT_API_KEY", "LIVEKIT_API_SECRET", "DEMO_USER_PASSWORD"] :
      contains(keys(var.secret_values), k)
    ])
    error_message = "secret_values must contain all six required keys."
  }
}

provider "kubernetes" {
  config_path    = "~/.kube/config"
  config_context = var.kube_context
}

provider "helm" {
  kubernetes {
    config_path    = "~/.kube/config"
    config_context = var.kube_context
  }
}

resource "kubernetes_namespace" "davrabox" {
  metadata {
    name = var.namespace
    labels = {
      "pod-security.kubernetes.io/enforce" = "baseline"
      "pod-security.kubernetes.io/warn"    = "restricted"
    }
  }
}

resource "kubernetes_secret" "app" {
  metadata {
    name      = "davrabox-secrets"
    namespace = kubernetes_namespace.davrabox.metadata[0].name
  }
  data = var.secret_values
}

resource "kubernetes_resource_quota" "ns" {
  metadata {
    name      = "davrabox-quota"
    namespace = kubernetes_namespace.davrabox.metadata[0].name
  }
  spec {
    hard = {
      "requests.cpu"    = "8"
      "requests.memory" = "12Gi"
      "limits.cpu"      = "24"
      "limits.memory"   = "32Gi"
      pods              = "60"
    }
  }
}

resource "helm_release" "davrabox" {
  name       = "davrabox"
  namespace  = kubernetes_namespace.davrabox.metadata[0].name
  chart      = "${path.module}/../../../helm/davrabox"
  timeout    = 600
  depends_on = [kubernetes_secret.app]

  set {
    name  = "publicHost"
    value = var.public_host
  }
  set {
    name  = "keycloak.realmJson"
    value = file("${path.module}/${var.realm_json_path}")
    type  = "string"
  }
}
