import { Module } from '@nestjs/common';
import { DocumentsModule } from '../documents/documents.module';
import { PrivacyController } from './privacy.controller';
import { PrivacyService } from './privacy.service';
import { WhistleblowingService } from './whistleblowing.service';

@Module({ imports: [DocumentsModule], controllers: [PrivacyController], providers: [PrivacyService, WhistleblowingService] })
export class PrivacyModule {}
