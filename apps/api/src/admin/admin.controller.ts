import {
  Body,
  CanActivate,
  Controller,
  Delete,
  ExecutionContext,
  ForbiddenException,
  Get,
  HttpCode,
  HttpException,
  Inject,
  Injectable,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { z } from 'zod';
import { AuthGuard, type AuthedUser } from '../auth/auth.guard.js';
import { AdminError, AdminService } from './admin.service.js';
import { policiesSchema } from './policies.js';

export const ADMIN = Symbol('ADMIN');

/** Runs after AuthGuard: only organization admins pass. */
@Injectable()
export class AdminGuard implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    const user = ctx.switchToHttp().getRequest().user as AuthedUser | undefined;
    if (user?.role !== 'org_admin') throw new ForbiddenException('organization admin role required');
    return true;
  }
}

const uuid = z.string().uuid();
const personName = z.string().trim().min(1).max(80);
const emailSchema = z.string().trim().toLowerCase().max(255).pipe(z.email());
const createUserSchema = z
  .object({
    email: emailSchema,
    firstName: personName,
    lastName: personName,
    role: z.enum(['org_admin', 'member']),
    departmentId: uuid.optional(),
  })
  .strict();
const updateUserSchema = z
  .object({
    role: z.enum(['org_admin', 'member']).optional(),
    departmentId: uuid.nullable().optional(),
    disabled: z.boolean().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'empty update');
const listSchema = z.object({
  search: z.string().trim().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().max(200).optional(),
});
const departmentSchema = z.object({ name: z.string().trim().min(1).max(80) }).strict();

type Request = { user: AuthedUser };

function parse<T>(schema: z.ZodType<T>, v: unknown): T {
  const r = schema.safeParse(v);
  if (!r.success) throw new HttpException('invalid input', 400);
  return r.data;
}

function wrap<T>(p: Promise<T>): Promise<T> {
  return p.catch((e) => {
    if (e instanceof AdminError) throw new HttpException(e.message, e.status);
    throw e;
  });
}

@Controller('v1/admin')
@UseGuards(AuthGuard, AdminGuard)
export class AdminController {
  constructor(@Inject(ADMIN) private readonly svc: AdminService) {}

  @Get('overview')
  overview(@Req() req: Request) {
    return wrap(this.svc.overview(req.user));
  }

  @Get('users')
  listUsers(@Req() req: Request, @Query() q: unknown) {
    return wrap(this.svc.listUsers(req.user, parse(listSchema, q)));
  }

  @Post('users')
  createUser(@Req() req: Request, @Body() body: unknown) {
    return wrap(this.svc.createUser(req.user, parse(createUserSchema, body)));
  }

  @Patch('users/:id')
  updateUser(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) {
    const patch = parse(updateUserSchema, body);
    if (!uuid.safeParse(id).success) throw new HttpException('user not found', 404);
    return wrap(this.svc.updateUser(req.user, id, patch));
  }

  @Get('departments')
  listDepartments(@Req() req: Request) {
    return wrap(this.svc.listDepartments(req.user));
  }

  @Post('departments')
  createDepartment(@Req() req: Request, @Body() body: unknown) {
    return wrap(this.svc.createDepartment(req.user, parse(departmentSchema, body).name));
  }

  @Patch('departments/:id')
  renameDepartment(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) {
    const { name } = parse(departmentSchema, body);
    return wrap(this.svc.renameDepartment(req.user, id, name));
  }

  @Delete('departments/:id')
  @HttpCode(200)
  deleteDepartment(@Req() req: Request, @Param('id') id: string) {
    return wrap(this.svc.deleteDepartment(req.user, id));
  }

  @Get('policies')
  getPolicies(@Req() req: Request) {
    return wrap(this.svc.getPolicies(req.user));
  }

  @Put('policies')
  setPolicies(@Req() req: Request, @Body() body: unknown) {
    return wrap(this.svc.setPolicies(req.user, parse(policiesSchema, body)));
  }
}
