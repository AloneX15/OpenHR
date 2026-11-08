variable "subscription_id" {
  description = "Suscripción de Azure donde se despliega."
  type        = string
}

variable "name" {
  description = "Prefijo de los recursos (minúsculas y números, 3-12 caracteres)."
  type        = string
  default     = "openhr"
  validation {
    condition     = can(regex("^[a-z][a-z0-9]{2,11}$", var.name))
    error_message = "Usa de 3 a 12 minúsculas o números, empezando por letra."
  }
}

variable "location" {
  description = "Región de Azure. Por defecto, España Central (los datos se quedan en España)."
  type        = string
  default     = "spaincentral"
}

variable "image_api" {
  description = "Imagen de la API, p. ej. ghcr.io/alonex15/openhr-api:1.0.0"
  type        = string
}

variable "image_web" {
  description = "Imagen de la web, p. ej. ghcr.io/alonex15/openhr-web:1.0.0"
  type        = string
}

variable "registry_server" {
  description = "Registro privado de las imágenes (vacío si son públicas)."
  type        = string
  default     = ""
}

variable "registry_username" {
  type    = string
  default = ""
}

variable "registry_password" {
  type      = string
  default   = ""
  sensitive = true
}

variable "public_url" {
  description = "URL pública si usas dominio propio (https://rrhh.ejemplo.com). Vacío = la URL de Azure."
  type        = string
  default     = ""
}

variable "postgres_sku" {
  description = "Tamaño del servidor PostgreSQL. B_Standard_B1ms basta para un piloto; GP_Standard_D2ds_v5 para producción."
  type        = string
  default     = "B_Standard_B1ms"
}

variable "postgres_storage_mb" {
  type    = number
  default = 32768
}

variable "postgres_backup_days" {
  description = "Días de copias de seguridad automáticas (7-35)."
  type        = number
  default     = 35
}

variable "postgres_high_availability" {
  description = "Alta disponibilidad con réplica en otra zona (solo SKU General Purpose)."
  type        = bool
  default     = false
}

variable "smtp_host" {
  type = string
}

variable "smtp_port" {
  type    = number
  default = 587
}

variable "smtp_user" {
  type    = string
  default = ""
}

variable "smtp_password" {
  type      = string
  default   = ""
  sensitive = true
}

variable "smtp_from" {
  type    = string
  default = "OpenHR <no-reply@example.com>"
}

variable "api_min_replicas" {
  description = "Réplicas mínimas de la API. Con más de una, el envío de emails y la conservación se hacen en todas (son seguros: usan bloqueos)."
  type        = number
  default     = 1
}

variable "tags" {
  type    = map(string)
  default = { app = "openhr" }
}
