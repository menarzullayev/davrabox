<#import "template.ftl" as layout>
<@layout.emailLayout>
<@layout.title text=msg("dbUpdateTitle")/>
<@layout.para text=msg("dbUpdateLead", newEmail)/>
<@layout.button href=link label=msg("dbUpdateButton")/>
<@layout.muted text=msg("dbLinkExpires", linkExpirationFormatter(linkExpiration))/>
<@layout.muted text=msg("dbUpdateIgnore")/>
</@layout.emailLayout>
