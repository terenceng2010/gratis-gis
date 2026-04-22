import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

import { CurrentUser } from '../auth/current-user.decorator.js';
import type { AuthUser } from '../auth/auth-sync.service.js';
import { GroupsService } from './groups.service.js';

class CreateGroupDto {
  @IsString() @MinLength(1) @MaxLength(120)
  title!: string;

  @IsOptional() @IsString() @MaxLength(2000)
  description?: string;

  @IsOptional() @IsEnum(['private', 'org', 'public'])
  access?: 'private' | 'org' | 'public';

  // The form sends this on create so a user who uploaded a custom
  // thumbnail before pressing Create doesn't have to re-upload after
  // navigating to the edit page. Matches the UpdateGroupDto shape.
  @IsOptional() @IsString() @MaxLength(2048)
  thumbnailUrl?: string | null;
}

class UpdateGroupDto {
  @IsOptional() @IsString() @MinLength(1) @MaxLength(120)
  title?: string;

  @IsOptional() @IsString() @MaxLength(2000)
  description?: string;

  @IsOptional() @IsEnum(['private', 'org', 'public'])
  access?: 'private' | 'org' | 'public';

  // Null clears a previously-set thumbnail.
  @IsOptional() @IsString() @MaxLength(2048)
  thumbnailUrl?: string | null;
}

class AddMemberDto {
  @IsString() userId!: string;
  @IsOptional() @IsEnum(['member', 'admin']) role?: 'member' | 'admin';
}

@ApiTags('groups')
@ApiBearerAuth()
@Controller('groups')
export class GroupsController {
  constructor(private readonly groups: GroupsService) {}

  @Get()
  list(@CurrentUser() user: AuthUser) {
    return this.groups.listVisible(user);
  }

  // NOTE: /groups/trash must be declared before /groups/:id so Nest's
  // route matcher doesn't treat "trash" as an id parameter.
  @Get('trash')
  listTrash(@CurrentUser() user: AuthUser) {
    return this.groups.listTrash(user);
  }

  @Get(':id')
  get(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.groups.get(user, id);
  }

  @Get(':id/members')
  listMembers(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.groups.listMembers(user, id);
  }

  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateGroupDto) {
    return this.groups.create(user, dto);
  }

  @Patch(':id')
  update(
    @CurrentUser() user: AuthUser,
    @Param('id') id: string,
    @Body() dto: UpdateGroupDto,
  ) {
    return this.groups.update(user, id, dto);
  }

  @Delete(':id')
  remove(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.groups.remove(user, id);
  }

  @Post(':id/restore')
  restore(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.groups.restore(user, id);
  }

  @Delete(':id/purge')
  purge(@CurrentUser() user: AuthUser, @Param('id') id: string) {
    return this.groups.purge(user, id);
  }

  @Post(':id/members')
  addMember(
    @CurrentUser() user: AuthUser,
    @Param('id') groupId: string,
    @Body() dto: AddMemberDto,
  ) {
    return this.groups.addMember(user, groupId, dto.userId, dto.role ?? 'member');
  }

  @Delete(':id/members/:userId')
  removeMember(
    @CurrentUser() user: AuthUser,
    @Param('id') groupId: string,
    @Param('userId') memberId: string,
  ) {
    return this.groups.removeMember(user, groupId, memberId);
  }
}
