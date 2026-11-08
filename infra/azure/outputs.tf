output "url" {
  description = "Dirección de OpenHR."
  value       = local.public_url
}

output "setup_token" {
  description = "Token que pide la configuración inicial."
  value       = random_password.setup_token.result
  sensitive   = true
}

output "run_migrations" {
  description = "Comando para aplicar las migraciones (tras el primer despliegue y cada actualización)."
  value       = "az containerapp job start --name ${azurerm_container_app_job.migrate.name} --resource-group ${azurerm_resource_group.main.name}"
}

output "postgres_server" {
  value = azurerm_postgresql_flexible_server.main.fqdn
}

output "storage_account" {
  value = azurerm_storage_account.main.name
}

output "encryption_key" {
  description = "Guárdala fuera de Azure: sin ella no se pueden leer los secretos MFA ni el canal de denuncias."
  value       = random_bytes.encryption_key.base64
  sensitive   = true
}
