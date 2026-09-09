import { ButtonComponent } from '../../shared/components/button/button.component';
import { Component, OnInit, Input, inject, signal } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { RouterModule } from '@angular/router';
import { CampaignsService } from '../../core/services/campaigns.service';
import { Campaign } from '../../core/models/campaign.model';
import { GroupContextService } from '../../core/services/group-context.service';
@Component({ standalone:true, selector:'app-campaign-preview', imports:[ButtonComponent, CommonModule, FormsModule, RouterModule], template:`
  <details class="preview"><summary>Preview the next campaign email · no sending</summary>
    <p>Select a campaign and enrolled lead. Fixed sequences use the same approved copy and signature as production. AI cadence has no fixed next email; use the reply rehearsal below to test the SDR's behavior.</p>
    <div class="controls"><label>Campaign<select aria-label="Preview campaign" [(ngModel)]="campaignId" (ngModelChange)="selectCampaign()"><option value="">Choose campaign</option>@for(c of campaigns();track c.id){<option [value]="c.id">{{c.name}}</option>}</select></label>
    <label>Lead<select aria-label="Preview lead" [(ngModel)]="leadId" [disabled]="!selected()"><option value="">Choose enrolled lead</option>@for(row of selected()?.campaignLeads || [];track row.id){<option [value]="row.lead.id">{{row.lead.companyName}}</option>}</select></label>
    <app-button variant="secondary" size="sm" [disabled]="!leadId" [loading]="busy()" (clicked)="preview()">Preview next email</app-button></div>
    @if(error()){<p role="alert">{{error()}}</p>}
    @if(result();as r){<h4>{{r.subject || 'No fixed email available'}}</h4><p style="white-space:pre-wrap">{{r.body}}</p><p>Sender: {{r.sender || 'Not available'}}</p><ul>@for(reason of r.blockers;track $index){<li>{{reason}}</li>}</ul>}
    @if(campaignId){<app-button variant="secondary" size="sm" [link]="context.link('campaigns', campaignId)">Inspect sequence and enrollment</app-button>}
  </details>`, styles:[`.preview{padding:16px;margin-bottom:18px;border:1px solid var(--border-primary);border-radius:8px;font-size:13px;}summary{cursor:pointer;}p{color:var(--text-secondary);line-height:1.6;}.controls{display:flex;gap:12px;align-items:end;flex-wrap:wrap;margin:14px 0;}label{max-width:100%;display:flex;flex-direction:column;gap:5px;}select{max-width:100%;height:34px;padding:4px 10px;border:1px solid var(--border-primary);border-radius:8px;background:var(--bg-input);color:var(--text-primary);}button:disabled{opacity:.5;}`] })
export class CampaignPreviewComponent implements OnInit {
 @Input() groupId='';
 context=inject(GroupContextService);
 private service=inject(CampaignsService);
 campaigns=signal<Campaign[]>([]);selected=signal<Campaign|null>(null);
 campaignId='';leadId='';busy=signal(false);error=signal('');
 result=signal<{subject:string|null;body:string|null;sender:string|null;blockers:string[]}|null>(null);
 ngOnInit():void {this.service.list(this.groupId||undefined).subscribe({next:rows=>this.campaigns.set(rows),error:()=>this.error.set('Could not load campaigns.')});}
 selectCampaign():void{this.leadId='';this.selected.set(null);this.result.set(null);this.error.set('');const id=this.campaignId;if(!id)return;this.service.get(id,this.groupId||undefined).subscribe({next:c=>{if(this.campaignId===id)this.selected.set(c);},error:()=>this.error.set('Could not load campaign leads.')});}
 preview():void{if(!this.leadId)return;this.busy.set(true);this.result.set(null);this.error.set('');this.service.preview(this.campaignId,this.leadId).subscribe({next:r=>{this.result.set(r);this.busy.set(false);},error:()=>{this.error.set('Preview failed. Check the enrollment and try again.');this.busy.set(false);}});}
}
