<#import "template.ftl" as layout>
<@layout.emailLayout>
<@layout.title text=msg("dbResetTitle")/>
<@layout.para text=msg("dbResetLead")/>
<@layout.button href=link label=msg("dbResetButton")/>
<@layout.muted text=msg("dbLinkExpires", linkExpirationFormatter(linkExpiration))/>
<@layout.muted text=msg("dbResetIgnore")/>
</@layout.emailLayout>
