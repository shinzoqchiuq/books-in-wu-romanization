sudo rm -r ./.git/
git init
git add .
git commit -m "pdf"
git branch -m master pdf
git remote add origin git@github.com:shinzoqchiuq/books-in-wu-romanization.git
git remote add origin git@gitee.com:shinzoqchiuq/books-in-wu-romanization.git
git push -uf origin pdf
