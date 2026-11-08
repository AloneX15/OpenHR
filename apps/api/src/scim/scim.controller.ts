import {
  ArgumentsHost,
  Body,
  Catch,
  Controller,
  Delete,
  ExceptionFilter,
  Get,
  Headers,
  HttpCode,
  HttpException,
  Module,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Put,
  Query,
  Res,
  UseFilters,
} from '@nestjs/common';
import type { Response } from 'express';
import { z } from 'zod';
import { loadActor } from '../common/access';
import { CurrentUser, parse, Public, SessionUser } from '../common/http';
import { Db } from '../db/db.service';
import { applyPatch, fromScim, SCIM_ERROR, SCIM_PATCH, SCIM_USER, ScimError, ScimService } from './scim.service';

/** Todas las respuestas de error de /scim con el esquema de SCIM. */
@Catch()
class ScimFilter implements ExceptionFilter {
  catch(err: any, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    res.setHeader('Content-Type', 'application/scim+json');
    if (err instanceof ScimError) return res.status(err.getStatus()).send(JSON.stringify(err.getResponse()));
    const status = err instanceof HttpException ? err.getStatus() : 500;
    const detail = err instanceof HttpException ? String((err.getResponse() as any)?.message ?? err.message) : 'Error interno';
    return res.status(status).send(JSON.stringify({ schemas: [SCIM_ERROR], status: String(status), detail }));
  }
}

const send = (res: Response, status: number, body: unknown) => {
  res.status(status).setHeader('Content-Type', 'application/scim+json');
  res.send(JSON.stringify(body));
};

@Public()
@UseFilters(ScimFilter)
@Controller('scim/v2')
export class ScimController {
  constructor(private readonly scim: ScimService) {}

  @Get('ServiceProviderConfig')
  config(@Res() res: Response) {
    send(res, 200, {
      schemas: ['urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig'],
      documentationUri: 'https://github.com/AloneX15/OpenHR/blob/main/docs/scim.md',
      patch: { supported: true },
      bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
      filter: { supported: true, maxResults: 200 },
      changePassword: { supported: false },
      sort: { supported: false },
      etag: { supported: false },
      authenticationSchemes: [{ type: 'oauthbearertoken', name: 'Token de portador', description: 'Token de SCIM creado en OpenHR', primary: true }],
    });
  }

  @Get('ResourceTypes')
  resourceTypes(@Res() res: Response) {
    send(res, 200, {
      schemas: ['urn:ietf:params:scim:api:messages:2.0:ListResponse'],
      totalResults: 1,
      Resources: [{ schemas: ['urn:ietf:params:scim:schemas:core:2.0:ResourceType'], id: 'User', name: 'User', endpoint: '/Users', schema: SCIM_USER }],
    });
  }

  @Get('Users')
  async list(@Headers('authorization') auth: string, @Query() q: any, @Res() res: Response) {
    send(res, 200, await this.scim.withToken(auth, (tx) => this.scim.list(tx, q)));
  }

  @Get('Users/:id')
  async read(@Headers('authorization') auth: string, @Param('id') id: string, @Res() res: Response) {
    send(res, 200, await this.scim.withToken(auth, (tx) => this.scim.read(tx, id)));
  }

  @Post('Users')
  async create(@Headers('authorization') auth: string, @Body() body: any, @Res() res: Response) {
    send(res, 201, await this.scim.withToken(auth, (tx) => this.scim.create(tx, fromScim(body))));
  }

  @Put('Users/:id')
  async replace(@Headers('authorization') auth: string, @Param('id') id: string, @Body() body: any, @Res() res: Response) {
    const input = fromScim(body);
    send(res, 200, await this.scim.withToken(auth, (tx) => this.scim.update(tx, id, { ...input, active: input.active ?? true })));
  }

  @Patch('Users/:id')
  async patch(@Headers('authorization') auth: string, @Param('id') id: string, @Body() body: any, @Res() res: Response) {
    if (!Array.isArray(body?.schemas) || !body.schemas.includes(SCIM_PATCH)) throw new ScimError(400, 'Falta el esquema PatchOp', 'invalidSyntax');
    const input = applyPatch(body.Operations);
    send(res, 200, await this.scim.withToken(auth, (tx) => this.scim.update(tx, id, input)));
  }

  @Delete('Users/:id')
  @HttpCode(204)
  async remove(@Headers('authorization') auth: string, @Param('id') id: string) {
    await this.scim.withToken(auth, (tx) => this.scim.remove(tx, id));
  }

  @Get('Groups')
  async groups(@Headers('authorization') auth: string, @Res() res: Response) {
    // Los grupos no se sincronizan: los roles se asignan en OpenHR.
    await this.scim.withToken(auth, async () => undefined);
    send(res, 200, { schemas: ['urn:ietf:params:scim:api:messages:2.0:ListResponse'], totalResults: 0, startIndex: 1, itemsPerPage: 0, Resources: [] });
  }
}

/** Gestión de los tokens de SCIM desde Organización → Inicio de sesión. */
@Controller('scim-tokens')
export class ScimTokensController {
  constructor(
    private readonly db: Db,
    private readonly scim: ScimService,
  ) {}

  @Get()
  list(@CurrentUser() u: SessionUser) {
    return this.db.tx(u.tenantId, u.userId, async (tx) => this.scim.listTokens(tx, await loadActor(tx)));
  }

  @Post()
  create(@CurrentUser() u: SessionUser, @Body() body: unknown) {
    const { label } = parse(z.object({ label: z.string().trim().min(1).max(80) }), body);
    return this.db.tx(u.tenantId, u.userId, async (tx) => this.scim.createToken(tx, await loadActor(tx), label));
  }

  @Delete(':id')
  revoke(@CurrentUser() u: SessionUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.db.tx(u.tenantId, u.userId, async (tx) => this.scim.revokeToken(tx, await loadActor(tx), id));
  }
}

@Module({ controllers: [ScimController, ScimTokensController], providers: [ScimService] })
export class ScimModule {}
