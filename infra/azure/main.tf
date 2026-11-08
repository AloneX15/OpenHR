# OpenHR en Azure: Container Apps + PostgreSQL Flexible Server (red privada) + Blob Storage
# con identidad gestionada. Ver docs/despliegue-azure.md.

locals {
  prefix     = var.name
  public_url = var.public_url != "" ? var.public_url : "https://${azurerm_container_app.web.ingress[0].fqdn}"
  db_name    = "openhr"
  registry   = var.registry_server != "" ? [1] : []
}

resource "azurerm_resource_group" "main" {
  name     = "rg-${local.prefix}"
  location = var.location
  tags     = var.tags
}

resource "azurerm_log_analytics_workspace" "main" {
  name                = "log-${local.prefix}"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  sku                 = "PerGB2018"
  retention_in_days   = 30
  tags                = var.tags
}

# ── Red ─────────────────────────────────────────────────────────────────────────────
resource "azurerm_virtual_network" "main" {
  name                = "vnet-${local.prefix}"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  address_space       = ["10.20.0.0/16"]
  tags                = var.tags
}

resource "azurerm_subnet" "apps" {
  name                 = "snet-apps"
  resource_group_name  = azurerm_resource_group.main.name
  virtual_network_name = azurerm_virtual_network.main.name
  address_prefixes     = ["10.20.0.0/23"]
  delegation {
    name = "aca"
    service_delegation {
      name    = "Microsoft.App/environments"
      actions = ["Microsoft.Network/virtualNetworks/subnets/join/action"]
    }
  }
}

resource "azurerm_subnet" "db" {
  name                 = "snet-db"
  resource_group_name  = azurerm_resource_group.main.name
  virtual_network_name = azurerm_virtual_network.main.name
  address_prefixes     = ["10.20.2.0/24"]
  service_endpoints    = ["Microsoft.Storage"]
  delegation {
    name = "postgres"
    service_delegation {
      name    = "Microsoft.DBforPostgreSQL/flexibleServers"
      actions = ["Microsoft.Network/virtualNetworks/subnets/join/action"]
    }
  }
}

resource "azurerm_private_dns_zone" "db" {
  name                = "${local.prefix}.postgres.database.azure.com"
  resource_group_name = azurerm_resource_group.main.name
  tags                = var.tags
}

resource "azurerm_private_dns_zone_virtual_network_link" "db" {
  name                  = "db-link"
  resource_group_name   = azurerm_resource_group.main.name
  private_dns_zone_name = azurerm_private_dns_zone.db.name
  virtual_network_id    = azurerm_virtual_network.main.id
}

# ── Secretos generados ──────────────────────────────────────────────────────────────
resource "random_password" "db_owner" {
  length  = 32
  special = false
}

resource "random_password" "db_app" {
  length  = 32
  special = false
}

resource "random_password" "jwt" {
  length  = 64
  special = false
}

resource "random_bytes" "encryption_key" {
  length = 32
}

resource "random_password" "setup_token" {
  length  = 24
  special = false
}

resource "random_string" "suffix" {
  length  = 6
  upper   = false
  special = false
}

# ── PostgreSQL (solo accesible desde la red privada) ────────────────────────────────
resource "azurerm_postgresql_flexible_server" "main" {
  name                          = "psql-${local.prefix}-${random_string.suffix.result}"
  location                      = azurerm_resource_group.main.location
  resource_group_name           = azurerm_resource_group.main.name
  version                       = "17"
  sku_name                      = var.postgres_sku
  storage_mb                    = var.postgres_storage_mb
  backup_retention_days         = var.postgres_backup_days
  geo_redundant_backup_enabled  = false
  delegated_subnet_id           = azurerm_subnet.db.id
  private_dns_zone_id           = azurerm_private_dns_zone.db.id
  public_network_access_enabled = false
  administrator_login           = "openhr_owner"
  administrator_password        = random_password.db_owner.result
  zone                          = "1"

  dynamic "high_availability" {
    for_each = var.postgres_high_availability ? [1] : []
    content {
      mode = "ZoneRedundant"
    }
  }

  tags       = var.tags
  depends_on = [azurerm_private_dns_zone_virtual_network_link.db]
}

# La migración 001 crea la extensión pgcrypto: hay que permitirla en Azure.
resource "azurerm_postgresql_flexible_server_configuration" "extensions" {
  name      = "azure.extensions"
  server_id = azurerm_postgresql_flexible_server.main.id
  value     = "PGCRYPTO"
}

resource "azurerm_postgresql_flexible_server_configuration" "tz" {
  name      = "timezone"
  server_id = azurerm_postgresql_flexible_server.main.id
  value     = "UTC"
}

resource "azurerm_postgresql_flexible_server_database" "main" {
  name      = local.db_name
  server_id = azurerm_postgresql_flexible_server.main.id
  charset   = "UTF8"
  collation = "en_US.utf8"
}

# ── Almacenamiento de documentos ────────────────────────────────────────────────────
resource "azurerm_storage_account" "main" {
  name                            = "st${local.prefix}${random_string.suffix.result}"
  location                        = azurerm_resource_group.main.location
  resource_group_name             = azurerm_resource_group.main.name
  account_tier                    = "Standard"
  account_replication_type        = "ZRS"
  min_tls_version                 = "TLS1_2"
  allow_nested_items_to_be_public = false
  shared_access_key_enabled       = false
  https_traffic_only_enabled      = true

  blob_properties {
    versioning_enabled = true
    delete_retention_policy {
      days = 30
    }
    container_delete_retention_policy {
      days = 30
    }
  }
  tags = var.tags
}

resource "azurerm_storage_container" "documents" {
  name                  = "openhr"
  storage_account_id    = azurerm_storage_account.main.id
  container_access_type = "private"
}

# Identidad de la API: escribe en el contenedor sin secretos.
resource "azurerm_user_assigned_identity" "api" {
  name                = "id-${local.prefix}-api"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  tags                = var.tags
}

resource "azurerm_role_assignment" "api_blob" {
  scope                = azurerm_storage_account.main.id
  role_definition_name = "Storage Blob Data Contributor"
  principal_id         = azurerm_user_assigned_identity.api.principal_id
}

# ── Container Apps ──────────────────────────────────────────────────────────────────
resource "azurerm_container_app_environment" "main" {
  name                       = "cae-${local.prefix}"
  location                   = azurerm_resource_group.main.location
  resource_group_name        = azurerm_resource_group.main.name
  log_analytics_workspace_id = azurerm_log_analytics_workspace.main.id
  infrastructure_subnet_id   = azurerm_subnet.apps.id
  tags                       = var.tags

  workload_profile {
    name                  = "Consumption"
    workload_profile_type = "Consumption"
  }
}

locals {
  db_host          = azurerm_postgresql_flexible_server.main.fqdn
  app_database_url = "postgres://openhr_app:${random_password.db_app.result}@${local.db_host}:5432/${local.db_name}?sslmode=require"
  owner_db_url     = "postgres://openhr_owner:${random_password.db_owner.result}@${local.db_host}:5432/${local.db_name}?sslmode=require"
}

# Migraciones: trabajo manual que se lanza tras cada actualización (ver outputs).
resource "azurerm_container_app_job" "migrate" {
  name                         = "job-${local.prefix}-migrate"
  location                     = azurerm_resource_group.main.location
  resource_group_name          = azurerm_resource_group.main.name
  container_app_environment_id = azurerm_container_app_environment.main.id
  replica_timeout_in_seconds   = 600
  replica_retry_limit          = 1
  workload_profile_name        = "Consumption"

  manual_trigger_config {
    parallelism              = 1
    replica_completion_count = 1
  }

  dynamic "registry" {
    for_each = local.registry
    content {
      server               = var.registry_server
      username             = var.registry_username
      password_secret_name = "registry-password"
    }
  }

  dynamic "secret" {
    for_each = local.registry
    content {
      name  = "registry-password"
      value = var.registry_password
    }
  }

  secret {
    name  = "migration-database-url"
    value = local.owner_db_url
  }

  secret {
    name  = "app-db-password"
    value = random_password.db_app.result
  }

  template {
    container {
      name    = "migrate"
      image   = var.image_api
      cpu     = 0.25
      memory  = "0.5Gi"
      command = ["node", "dist/db/migrate.js"]
      env {
        name        = "MIGRATION_DATABASE_URL"
        secret_name = "migration-database-url"
      }
      env {
        name        = "OPENHR_APP_DB_PASSWORD"
        secret_name = "app-db-password"
      }
    }
  }
  tags = var.tags
}

resource "azurerm_container_app" "api" {
  name                         = "${local.prefix}-api"
  container_app_environment_id = azurerm_container_app_environment.main.id
  resource_group_name          = azurerm_resource_group.main.name
  revision_mode                = "Single"
  workload_profile_name        = "Consumption"

  identity {
    type         = "UserAssigned"
    identity_ids = [azurerm_user_assigned_identity.api.id]
  }

  dynamic "registry" {
    for_each = local.registry
    content {
      server               = var.registry_server
      username             = var.registry_username
      password_secret_name = "registry-password"
    }
  }

  dynamic "secret" {
    for_each = local.registry
    content {
      name  = "registry-password"
      value = var.registry_password
    }
  }

  secret {
    name  = "database-url"
    value = local.app_database_url
  }
  secret {
    name  = "jwt-secret"
    value = random_password.jwt.result
  }
  secret {
    name  = "encryption-key"
    value = random_bytes.encryption_key.base64
  }
  secret {
    name  = "setup-token"
    value = random_password.setup_token.result
  }
  secret {
    name  = "smtp-password"
    value = var.smtp_password == "" ? "-" : var.smtp_password
  }
  secret {
    name  = "vapid-private-key"
    value = var.vapid_private_key == "" ? "-" : var.vapid_private_key
  }

  # Solo accesible desde dentro del entorno (la web le reenvía /api).
  ingress {
    external_enabled = false
    target_port      = 3001
    transport        = "http"
    traffic_weight {
      latest_revision = true
      percentage      = 100
    }
  }

  template {
    min_replicas = var.api_min_replicas
    max_replicas = 5

    container {
      name   = "api"
      image  = var.image_api
      cpu    = 0.5
      memory = "1Gi"

      env {
        name  = "NODE_ENV"
        value = "production"
      }
      env {
        name  = "PORT"
        value = "3001"
      }
      env {
        name        = "DATABASE_URL"
        secret_name = "database-url"
      }
      env {
        name        = "JWT_SECRET"
        secret_name = "jwt-secret"
      }
      env {
        name        = "ENCRYPTION_KEY"
        secret_name = "encryption-key"
      }
      env {
        name        = "SETUP_TOKEN"
        secret_name = "setup-token"
      }
      env {
        name  = "PUBLIC_URL"
        value = var.public_url != "" ? var.public_url : "https://${local.prefix}-web.${azurerm_container_app_environment.main.default_domain}"
      }
      env {
        name  = "SECURE_COOKIES"
        value = "true"
      }
      env {
        name  = "STORAGE_DRIVER"
        value = "azure"
      }
      env {
        name  = "AZURE_STORAGE_ACCOUNT"
        value = azurerm_storage_account.main.name
      }
      env {
        name  = "AZURE_STORAGE_CONTAINER"
        value = azurerm_storage_container.documents.name
      }
      env {
        # DefaultAzureCredential usa esta identidad gestionada.
        name  = "AZURE_CLIENT_ID"
        value = azurerm_user_assigned_identity.api.client_id
      }
      env {
        name  = "SMTP_HOST"
        value = var.smtp_host
      }
      env {
        name  = "SMTP_PORT"
        value = tostring(var.smtp_port)
      }
      env {
        name  = "SMTP_USER"
        value = var.smtp_user
      }
      env {
        name        = "SMTP_PASSWORD"
        secret_name = "smtp-password"
      }
      env {
        name  = "SMTP_FROM"
        value = var.smtp_from
      }
      env {
        name  = "VAPID_PUBLIC_KEY"
        value = var.vapid_public_key
      }
      env {
        name        = "VAPID_PRIVATE_KEY"
        secret_name = "vapid-private-key"
      }
      env {
        name  = "VAPID_SUBJECT"
        value = var.vapid_subject
      }
      env {
        name  = "TZ"
        value = "UTC"
      }

      liveness_probe {
        transport = "HTTP"
        port      = 3001
        path      = "/api/health"
      }
      readiness_probe {
        transport = "HTTP"
        port      = 3001
        path      = "/api/health"
      }
    }
  }
  tags = var.tags
}

resource "azurerm_container_app" "web" {
  name                         = "${local.prefix}-web"
  container_app_environment_id = azurerm_container_app_environment.main.id
  resource_group_name          = azurerm_resource_group.main.name
  revision_mode                = "Single"
  workload_profile_name        = "Consumption"

  dynamic "registry" {
    for_each = local.registry
    content {
      server               = var.registry_server
      username             = var.registry_username
      password_secret_name = "registry-password"
    }
  }

  dynamic "secret" {
    for_each = local.registry
    content {
      name  = "registry-password"
      value = var.registry_password
    }
  }

  ingress {
    external_enabled = true
    target_port      = 3000
    transport        = "auto"
    traffic_weight {
      latest_revision = true
      percentage      = 100
    }
  }

  template {
    min_replicas = 1
    max_replicas = 5

    container {
      name   = "web"
      image  = var.image_web
      cpu    = 0.5
      memory = "1Gi"

      env {
        # Nombre interno de la API dentro del entorno de Container Apps.
        name  = "API_URL"
        value = "http://${local.prefix}-api"
      }
      liveness_probe {
        transport = "HTTP"
        port      = 3000
        path      = "/login"
      }
    }
  }
  tags = var.tags
}
