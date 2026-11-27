<#import "template.ftl" as layout>
<@layout.emailLayout>
<@layout.title text=msg("dbVerifyTitle")/>
<@layout.para text=msg("dbVerifyLead")/>
<@layout.button href=link label=msg("dbVerifyButton")/>
<@layout.muted text=msg("dbLinkExpires", linkExpirationFormatter(linkExpiration))/>
<@layout.muted text=msg("dbVerifyIgnore")/>
</@layout.emailLayout>
